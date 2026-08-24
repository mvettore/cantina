import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

// Posizione di ripiego quando la geolocalizzazione non è disponibile o negata.
const DEFAULT_POS = { lat: 44.8907, lng: 8.6608, label: 'Spinetta Marengo (AL)' }

const FUELS = [
  { key: 'benzina', label: 'Benzina', match: /benzina/i },
  { key: 'gasolio', label: 'Gasolio', match: /gasolio|diesel/i },
  { key: 'gpl',     label: 'GPL',     match: /gpl/i },
  { key: 'metano',  label: 'Metano',  match: /metano|cng/i },
]

const RADII = [5, 10, 15, 25]

function haversineKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('benzina-prefs') || '{}') } catch { return {} }
}
function savePrefs(prefs) {
  try { localStorage.setItem('benzina-prefs', JSON.stringify(prefs)) } catch {}
}

function formatDate(iso) {
  if (!iso) return null
  const d = new Date(iso.replace(' ', 'T'))
  if (isNaN(d)) return null
  return d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function BenzinaApp() {
  const prefs = useRef(loadPrefs()).current

  const [fuel, setFuel] = useState(prefs.fuel || 'benzina')
  const [selfService, setSelfService] = useState(prefs.selfService !== undefined ? prefs.selfService : true)
  const [radius, setRadius] = useState(prefs.radius || 10)
  const [sortBy, setSortBy] = useState(prefs.sortBy || 'price')

  const [pos, setPos] = useState(prefs.pos || DEFAULT_POS)
  const [locating, setLocating] = useState(false)
  const [query, setQuery] = useState('')

  const [stations, setStations] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    savePrefs({ fuel, selfService, radius, sortBy, pos })
  }, [fuel, selfService, radius, sortBy, pos])

  const fetchStations = useCallback(async (p, r) => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`/.netlify/functions/fuel-prices?lat=${p.lat}&lng=${p.lng}&radius=${r}`)
      const text = await resp.text()
      let data = {}
      try { data = JSON.parse(text) } catch {}
      if (!resp.ok || !Array.isArray(data.results)) {
        throw new Error(data.error || `Errore ${resp.status}: ${text.slice(0, 180) || 'risposta vuota'}`)
      }
      setStations(data.results)
    } catch (err) {
      // Fallback: chiamata diretta all'API del ministero dal browser (IP italiano).
      // Funziona solo se il server consente CORS; se no restiamo sull'errore del proxy.
      try {
        const resp = await fetch('https://carburanti.mise.gov.it/ospzApi/search/zone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ points: [{ lat: p.lat, lng: p.lng }], radius: r, fuelType: '0-x', priceOrder: 'asc' }),
        })
        const data = await resp.json()
        if (!Array.isArray(data.results)) throw new Error('risposta inattesa')
        setStations(data.results)
      } catch {
        setError(err.message)
        setStations(null)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStations(pos, radius)
  }, [pos, radius, fetchStations])

  // All'avvio prova subito a usare la posizione reale del dispositivo.
  useEffect(() => {
    locateMe(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function locateMe(silent = false) {
    if (!navigator.geolocation) {
      if (!silent) setError('Geolocalizzazione non supportata dal browser')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (geo) => {
        setLocating(false)
        setPos({ lat: geo.coords.latitude, lng: geo.coords.longitude, label: 'La mia posizione' })
      },
      () => {
        setLocating(false)
        if (!silent) setError('Impossibile ottenere la posizione: controlla i permessi del browser')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    )
  }

  async function searchPlace(e) {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setLocating(true)
    setError(null)
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&countrycodes=it&limit=1&q=${encodeURIComponent(q)}`,
      )
      const results = await resp.json()
      if (!results.length) throw new Error(`Nessun risultato per “${q}”`)
      setPos({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), label: results[0].display_name.split(',').slice(0, 2).join(',') })
      setQuery('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLocating(false)
    }
  }

  const fuelDef = FUELS.find((f) => f.key === fuel)

  const rows = useMemo(() => {
    if (!stations) return []
    const list = []
    for (const st of stations) {
      const loc = st.location || {}
      if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue
      const matching = (st.fuels || []).filter(
        (f) => fuelDef.match.test(f.name || '') && f.isSelf === selfService && Number.isFinite(f.price),
      )
      if (!matching.length) continue
      const best = matching.reduce((a, b) => (a.price <= b.price ? a : b))
      list.push({
        id: st.id,
        name: st.name || st.brand || 'Distributore',
        brand: st.brand || '',
        address: st.address || '',
        lat: loc.lat,
        lng: loc.lng,
        price: best.price,
        fuelName: best.name,
        updated: formatDate(st.insertDate),
        distance: haversineKm(pos, loc),
      })
    }
    list.sort((a, b) => (sortBy === 'price' ? a.price - b.price || a.distance - b.distance : a.distance - b.distance))
    return list
  }, [stations, fuelDef, selfService, sortBy, pos])

  const bestPrice = rows.length ? rows.reduce((m, r) => Math.min(m, r.price), Infinity) : null

  return (
    <div style={S.page}>
      <header style={S.header}>
        <div style={S.title}>⛽ Prezzi Carburanti</div>
        <div style={S.subtitle}>
          {pos.label || `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`} · raggio {radius} km
        </div>
      </header>

      <div style={S.controls}>
        <div style={S.chipRow}>
          {FUELS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFuel(f.key)}
              style={{ ...S.chip, ...(fuel === f.key ? S.chipActive : {}) }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div style={S.chipRow}>
          <button onClick={() => setSelfService(true)} style={{ ...S.chip, ...(selfService ? S.chipActive : {}) }}>
            Self
          </button>
          <button onClick={() => setSelfService(false)} style={{ ...S.chip, ...(!selfService ? S.chipActive : {}) }}>
            Servito
          </button>
          <span style={{ flex: 1 }} />
          <select value={radius} onChange={(e) => setRadius(Number(e.target.value))} style={S.select}>
            {RADII.map((r) => (
              <option key={r} value={r}>{r} km</option>
            ))}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={S.select}>
            <option value="price">↑ Prezzo</option>
            <option value="distance">↑ Distanza</option>
          </select>
        </div>

        <div style={S.chipRow}>
          <button onClick={() => locateMe(false)} disabled={locating} style={{ ...S.chip, ...S.chipWide }}>
            {locating ? '…' : '📍 Usa la mia posizione'}
          </button>
          <form onSubmit={searchPlace} style={{ display: 'flex', flex: 1, gap: 6 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cerca località…"
              style={S.input}
            />
            <button type="submit" style={S.chip}>Vai</button>
          </form>
        </div>
      </div>

      {loading && <div style={S.message}>Carico i prezzi dal portale del ministero…</div>}

      {error && !loading && (
        <div style={{ ...S.message, color: '#fca5a5' }}>
          {error}
          <div style={{ marginTop: 8 }}>
            <button onClick={() => fetchStations(pos, radius)} style={S.chip}>Riprova</button>
          </div>
        </div>
      )}

      {!loading && !error && rows.length === 0 && stations && (
        <div style={S.message}>
          Nessun distributore con {fuelDef.label} ({selfService ? 'self' : 'servito'}) entro {radius} km.
          Prova ad aumentare il raggio o cambiare tipo di servizio.
        </div>
      )}

      {!loading && rows.length > 0 && (
        <ul style={S.list}>
          {rows.map((r) => (
            <li key={r.id} style={{ ...S.card, ...(r.price === bestPrice ? S.cardBest : {}) }}>
              <div style={S.cardLeft}>
                <div style={S.stationName}>
                  {r.name}
                  {r.price === bestPrice && <span style={S.bestBadge}>più economico</span>}
                </div>
                <div style={S.stationMeta}>{r.address}</div>
                <div style={S.stationMeta}>
                  {r.distance.toFixed(1)} km
                  {r.fuelName && ` · ${r.fuelName}`}
                  {r.updated && ` · agg. ${r.updated}`}
                </div>
              </div>
              <div style={S.cardRight}>
                <div style={{ ...S.price, ...(r.price === bestPrice ? { color: '#4ade80' } : {}) }}>
                  {r.price.toFixed(3)} €
                </div>
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`}
                  target="_blank"
                  rel="noreferrer"
                  style={S.mapLink}
                >
                  Naviga →
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}

      <footer style={S.footer}>
        Dati: Osservaprezzi Carburanti — MIMIT (prezzi comunicati dai gestori, agg. giornaliero)
      </footer>
    </div>
  )
}

const S = {
  page: {
    minHeight: '100vh',
    background: '#0b1220',
    color: '#e2e8f0',
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    maxWidth: 560,
    margin: '0 auto',
    padding: '16px 12px calc(24px + env(safe-area-inset-bottom))',
    boxSizing: 'border-box',
  },
  header: { padding: '8px 4px 14px' },
  title: { fontSize: 24, fontWeight: 800, letterSpacing: -0.5 },
  subtitle: { fontSize: 13, color: '#94a3b8', marginTop: 4 },
  controls: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 },
  chipRow: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  chip: {
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 999,
    padding: '8px 14px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  chipActive: { background: '#2563eb', borderColor: '#2563eb', color: '#fff' },
  chipWide: { whiteSpace: 'nowrap' },
  select: {
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 10,
    padding: '8px 10px',
    fontSize: 14,
  },
  input: {
    flex: 1,
    minWidth: 0,
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 999,
    padding: '8px 14px',
    fontSize: 14,
    outline: 'none',
  },
  message: { padding: '28px 12px', textAlign: 'center', color: '#94a3b8', fontSize: 15, lineHeight: 1.5 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  card: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    background: '#111a2e',
    border: '1px solid #1e293b',
    borderRadius: 14,
    padding: '12px 14px',
  },
  cardBest: { borderColor: '#166534', background: '#0d1b17' },
  cardLeft: { minWidth: 0 },
  cardRight: { textAlign: 'right', flexShrink: 0 },
  stationName: { fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  bestBadge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    color: '#4ade80',
    background: '#14532d44',
    borderRadius: 6,
    padding: '2px 6px',
  },
  stationMeta: {
    fontSize: 12.5,
    color: '#94a3b8',
    marginTop: 3,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  price: { fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums' },
  mapLink: { fontSize: 13, color: '#60a5fa', textDecoration: 'none', fontWeight: 600 },
  footer: { marginTop: 22, textAlign: 'center', fontSize: 11.5, color: '#64748b', lineHeight: 1.5 },
}
