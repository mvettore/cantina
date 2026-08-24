/**
 * Prezzi carburanti per zona, con doppia fonte dati MIMIT (ex MISE):
 *
 * 1. API "live" del portale Osservaprezzi (https://carburanti.mise.gov.it/ospzApi)
 *    POST /search/zone { points:[{lat,lng}], radius, fuelType:"F-M", priceOrder }
 * 2. Fallback: open data ufficiali giornalieri (CSV delle 8:00)
 *    https://www.mimit.gov.it/it/open-data — prezzo_alle_8.csv + anagrafica_impianti_attivi.csv
 *    Stessi prezzi comunicati dai gestori, aggiornati ogni mattina.
 *
 * Il fallback serve perché il WAF del portale può rifiutare richieste
 * provenienti da datacenter esteri (le function Netlify girano su AWS).
 *
 * GET /.netlify/functions/fuel-prices?lat=44.89&lng=8.65&radius=10
 * Risposta: { success, source: "live"|"opendata", results:[{ id, name, brand,
 *   address, location:{lat,lng}, insertDate, fuels:[{name, price, isSelf, fuelId}] }] }
 */

const API_BASE = "https://carburanti.mise.gov.it/ospzApi";
const CSV_BASES = ["https://www.mimit.gov.it/images/exportCSV", "https://www.mise.gov.it/images/exportCSV"];

// Cache in memoria del container: sopravvive tra invocazioni "calde".
let csvCache = { at: 0, stations: null };
const CSV_TTL_MS = 30 * 60 * 1000;

// Se l'API live ha appena fallito, per un po' passiamo diretti agli open data
// senza bruciare secondi (il timeout della function è limitato).
let liveFailedAt = 0;
const LIVE_RETRY_MS = 10 * 60 * 1000;

export const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=300",
  };

  const params = event.queryStringParameters || {};
  const lat = parseFloat(params.lat);
  const lng = parseFloat(params.lng);
  const radius = Math.min(Math.max(parseFloat(params.radius) || 10, 1), 35);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Parametri lat/lng mancanti o non validi" }) };
  }

  const errors = [];

  // ── Fonte 1: API live del portale ──────────────────────────────────────────
  if (Date.now() - liveFailedAt > LIVE_RETRY_MS) {
    const live = await searchZoneLive(lat, lng, radius);
    if (live.data) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, source: "live", center: { lat, lng }, radius, results: live.data.results }),
      };
    }
    liveFailedAt = Date.now();
    errors.push(`API live: ${live.error}`);
  } else {
    errors.push("API live: saltata (fallita di recente)");
  }

  // ── Fonte 2: open data CSV giornalieri ─────────────────────────────────────
  try {
    const stations = await loadOpenData();
    const results = [];
    for (const st of stations) {
      const d = haversineKm(lat, lng, st.location.lat, st.location.lng);
      if (d <= radius) results.push(st);
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, source: "opendata", center: { lat, lng }, radius, results }),
    };
  } catch (err) {
    errors.push(`open data: ${err.message}`);
  }

  console.error(`[fuel-prices] tutte le fonti fallite: ${errors.join(" | ")}`);
  return {
    statusCode: 502,
    headers: { ...headers, "Cache-Control": "no-store" },
    body: JSON.stringify({ error: `Nessuna fonte dati raggiungibile — ${errors.join(" | ")}` }),
  };
};

async function searchZoneLive(lat, lng, radius) {
  try {
    const resp = await fetch(`${API_BASE}/search/zone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
      body: JSON.stringify({ points: [{ lat, lng }], radius, fuelType: "0-x", priceOrder: "asc" }),
      signal: AbortSignal.timeout(4000),
    });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) return { data: null, error: `HTTP ${resp.status} ${text.substring(0, 120)}` };
    let data;
    try { data = JSON.parse(text) } catch { return { data: null, error: `risposta non JSON: ${text.substring(0, 120)}` } }
    if (!data || !Array.isArray(data.results)) return { data: null, error: `JSON senza results: ${text.substring(0, 120)}` };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: `rete: ${err.message}` };
  }
}

async function loadOpenData() {
  if (csvCache.stations && Date.now() - csvCache.at < CSV_TTL_MS) return csvCache.stations;

  const [anagrafica, prezzi] = await Promise.all([
    fetchCsv("anagrafica_impianti_attivi.csv"),
    fetchCsv("prezzo_alle_8.csv"),
  ]);

  // anagrafica: idImpianto;Gestore;Bandiera;Tipo Impianto;Nome Impianto;Indirizzo;Comune;Provincia;Latitudine;Longitudine
  const byId = new Map();
  for (const cols of parseCsv(anagrafica)) {
    if (cols.length < 10) continue;
    const id = cols[0];
    const la = parseFloat(cols[8]);
    const lo = parseFloat(cols[9]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    byId.set(id, {
      id: Number(id) || id,
      name: cols[4] || cols[1] || "Distributore",
      brand: cols[2] || "",
      address: [cols[5], cols[6], cols[7] ? `(${cols[7]})` : ""].filter(Boolean).join(", "),
      location: { lat: la, lng: lo },
      insertDate: null,
      fuels: [],
    });
  }

  // prezzi: idImpianto;descCarburante;prezzo;isSelf;dtComu
  for (const cols of parseCsv(prezzi)) {
    if (cols.length < 5) continue;
    const st = byId.get(cols[0]);
    if (!st) continue;
    const price = parseFloat(String(cols[2]).replace(",", "."));
    if (!Number.isFinite(price)) continue;
    const iso = itDateToIso(cols[4]);
    st.fuels.push({ name: cols[1], price, isSelf: cols[3] === "1", fuelId: 0 });
    if (iso && (!st.insertDate || iso > st.insertDate)) st.insertDate = iso;
  }

  const stations = [...byId.values()].filter((s) => s.fuels.length > 0);
  csvCache = { at: Date.now(), stations };
  console.log(`[fuel-prices] open data caricati: ${stations.length} impianti con prezzi`);
  return stations;
}

async function fetchCsv(file) {
  let lastErr = "";
  for (const base of CSV_BASES) {
    try {
      const resp = await fetch(`${base}/${file}`, {
        headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { lastErr = `${base}: HTTP ${resp.status}`; continue }
      return await resp.text();
    } catch (err) {
      lastErr = `${base}: ${err.message}`;
    }
  }
  throw new Error(`${file} non scaricabile (${lastErr})`);
}

/** CSV MIMIT: separatore ';', prima riga = data estrazione, seconda = intestazioni. */
function* parseCsv(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    yield line.split(";").map((c) => c.trim());
  }
}

/** "17/03/2024 08:00:00" → "2024-03-17T08:00:00" (comparabile e parsabile ovunque). */
function itDateToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})[ T]?(\d{2}:\d{2}(?::\d{2})?)?/.exec(String(s || "").trim());
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] || "08:00:00"}`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
