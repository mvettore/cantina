import { useState, useRef, useEffect } from "react";

const WINE_TYPES = ["Rosso", "Bianco", "Rosato", "Spumante", "Dolce", "Passito"];
const REGIONS = ["Piemonte", "Toscana", "Veneto", "Lombardia", "Sicilia", "Campania", "Sardegna", "Umbria", "Marche", "Puglia", "Altro"];
const ROW_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const STORAGE_KEY = "cantina-wines-v3";
const RACKS_KEY  = "cantina-racks-v2";

const INITIAL_RACKS = [
  { id: 1, name: "Scaffale 1", rows: 4, cols: 6 },
  { id: 2, name: "Scaffale 2", rows: 3, cols: 8 },
];
const INITIAL_WINES = [
  { id: 1, name: "Barolo Riserva", producer: "Giacomo Conterno", year: 2017, region: "Piemonte", grape: "Nebbiolo", type: "Rosso", rating: 5, notes: "Struttura imponente, tannini setosi, finale lunghissimo.", quantity: 6, price: 120, rackId: 1, positions: ["A1","A2","A3","A4","A5","A6"], photo: null },
  { id: 2, name: "Brunello di Montalcino", producer: "Biondi Santi", year: 2016, region: "Toscana", grape: "Sangiovese Grosso", type: "Rosso", rating: 5, notes: "Eleganza assoluta, profumi di ciliegia e spezie.", quantity: 3, price: 180, rackId: 1, positions: ["B1","B2","B3"], photo: null },
  { id: 3, name: "Soave Classico", producer: "Pieropan", year: 2022, region: "Veneto", grape: "Garganega", type: "Bianco", rating: 4, notes: "Fresco, minerale, ottimo con pesce.", quantity: 12, price: 18, rackId: 2, positions: ["A1","A2","A3","A4","A5","A6","B1","B2","B3","B4","B5","B6"], photo: null },
];

// Migrazione dati vecchi (position -> positions)
function migrateWines(wines) {
  return wines.map(w => {
    if (w.position !== undefined && w.positions === undefined) {
      const { position, ...rest } = w;
      return { ...rest, positions: position ? [position] : [] };
    }
    if (w.positions === undefined) return { ...w, positions: [] };
    return w;
  });
}

// ── Local cache (usata come fallback offline) ──
function loadLocal(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}
function saveLocal(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// ── Cloud sync via Netlify Function ──
const IS_NETLIFY = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";

async function cloudLoad() {
  if (!IS_NETLIFY) return null;
  try {
    const r = await fetch("/.netlify/functions/data");
    if (!r.ok) return null;
    return await r.json(); // { wines, racks }
  } catch { return null; }
}

async function cloudSave(payload) {
  if (!IS_NETLIFY) return;
  try {
    await fetch("/.netlify/functions/data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) { console.warn("Cloud save failed:", e.message); }
}

const typeColors = {
  "Rosso":    { bar: "#9b3030", badge: "#6a2020", text: "#fcd8d8" },
  "Bianco":   { bar: "#9b9b30", badge: "#4a4a20", text: "#faf0c0" },
  "Rosato":   { bar: "#9b3060", badge: "#6a2040", text: "#fcd8e8" },
  "Spumante": { bar: "#307090", badge: "#204a60", text: "#c8eafa" },
  "Dolce":    { bar: "#9b6830", badge: "#5a3820", text: "#fae0b0" },
  "Passito":  { bar: "#602090", badge: "#3a1860", text: "#e0c8fa" },
};

// ── Utility: resize an image File to JPEG base64 ──
function resizeImage(file, maxPx = 900, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.src = URL.createObjectURL(file);
  });
}

// ── Call backend proxy → structured JSON ──
// In locale (npm run dev) chiama l'API Anthropic direttamente.
// In produzione (Netlify) chiama /api/scan-label che fa da proxy sicuro.
async function scanLabel(base64DataUrl) {
  const base64    = base64DataUrl.split(",")[1];
  const mediaType = base64DataUrl.split(";")[0].split(":")[1] || "image/jpeg";

  const isNetlify = window.location.hostname !== "localhost" &&
                    window.location.hostname !== "127.0.0.1";

  if (isNetlify) {
    // ── Produzione: chiama la Netlify Function (chiave API sicura sul server) ──
    const resp = await fetch("/.netlify/functions/scan-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64, mediaType }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Errore server ${resp.status}`);
    }
    return await resp.json();
  } else {
    // ── Sviluppo locale: chiama Anthropic direttamente (vedi .env.local) ──
    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Imposta VITE_ANTHROPIC_API_KEY in .env.local");

    const prompt = `Sei un esperto enologo. Analizza questa etichetta di vino.
Usa la ricerca web per trovare informazioni aggiuntive se necessario.
Restituisci ESCLUSIVAMENTE un oggetto JSON valido con questi campi:
{ "name": "...", "producer": "...", "year": 2019, "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito", "region": "...", "grape": "...", "notes": "...", "price": null }
Se un campo non è determinabile usa null.`;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
    if (!resp.ok) throw new Error(`API error ${resp.status}`);
    const data = await resp.json();
    const raw  = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const clean = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
    return JSON.parse(clean);
  }
}

const StarRating = ({ value, onChange, readonly }) => (
  <div style={{ display: "flex", gap: 3 }}>
    {[1,2,3,4,5].map(s => (
      <span key={s} onClick={() => !readonly && onChange(s)} style={{
        cursor: readonly ? "default" : "pointer",
        fontSize: readonly ? 20 : 28,
        color: s <= value ? "#c9953a" : "#b09878",
        transition: "color 0.15s", userSelect: "none",
      }}>★</span>
    ))}
  </div>
);

const TypeBadge = ({ type }) => {
  const c = typeColors[type] || { badge: "#555", text: "#eee" };
  return (
    <span style={{ background: c.badge, color: c.text, padding: "4px 13px", borderRadius: 20, fontSize: 13, fontFamily: "'Cinzel', serif", letterSpacing: 1, fontWeight: 700 }}>
      {type.toUpperCase()}
    </span>
  );
};

const emptyWine = () => ({
  id: null, name: "", producer: "", year: new Date().getFullYear(),
  region: "Toscana", grape: "", type: "Rosso",
  rating: 3, notes: "", quantity: 1, price: "", rackId: null, positions: [], photo: null, enrichment: null,
});
const emptyRack = () => ({ id: null, name: "", rows: 4, cols: 6 });

export default function App() {
  const [wines,   setWines]   = useState(() => migrateWines(loadLocal(STORAGE_KEY, INITIAL_WINES)));
  const [racks,   setRacks]   = useState(() => loadLocal(RACKS_KEY, INITIAL_RACKS));
  const [syncing, setSyncing] = useState(IS_NETLIFY); // true while loading from cloud
  const [view,    setView]    = useState("catalog");
  const [search,  setSearch]  = useState("");
  const [filterType, setFilterType] = useState("Tutti");
  const [sortBy,  setSortBy]  = useState("name");
  const [sortDir, setSortDir] = useState("desc");
  const [modal,   setModal]   = useState(null);
  const [editing, setEditing] = useState(null);
  const [deleteConfirm,     setDeleteConfirm]     = useState(null);
  const [rackModal,         setRackModal]         = useState(null);
  const [editingRack,       setEditingRack]       = useState(null);
  const [deleteRackConfirm, setDeleteRackConfirm] = useState(null);
  const [toast,   setToast]   = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichData, setEnrichData] = useState(null);
  const [enrichError, setEnrichError] = useState(null);
  const scanInputRef = useRef(null);
  const nextWineId = useRef(Math.max(...wines.map(w => w.id), 99) + 1);
  const nextRackId = useRef(Math.max(...racks.map(r => r.id), 99) + 1);

  // Carica dal cloud al primo avvio (sovrascrive il localStorage locale)
  useEffect(() => {
    if (!IS_NETLIFY) return;
    cloudLoad().then(data => {
      if (data) {
        if (data.wines) { const w = migrateWines(data.wines); setWines(w); saveLocal(STORAGE_KEY, w); }
        if (data.racks) { setRacks(data.racks); saveLocal(RACKS_KEY, data.racks); }
      }
      setSyncing(false);
    });
  }, []);

  const saveWines = (w) => {
    setWines(w);
    saveLocal(STORAGE_KEY, w);
    cloudSave({ wines: w });
  };
  const saveRacks = (r) => {
    setRacks(r);
    saveLocal(RACKS_KEY, r);
    cloudSave({ racks: r });
  };
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const filtered = wines
    .filter(w => filterType === "Tutti" || w.type === filterType)
    .filter(w => {
      const q = search.toLowerCase();
      return !q || [w.name, w.producer, w.region, w.grape].some(f => f?.toLowerCase().includes(q));
    })
    .sort((a, b) => {
      if (sortBy === "name")     return a.name.localeCompare(b.name);
      if (sortBy === "year")     return sortDir === "asc" ? a.year - b.year : b.year - a.year;
      if (sortBy === "rating")   return b.rating - a.rating;
      if (sortBy === "quantity") return b.quantity - a.quantity;
      return 0;
    });

  const totalBottles = wines.reduce((s, w) => s + w.quantity, 0);
  const totalValue   = wines.reduce((s, w) => s + w.quantity * (parseFloat(w.price) || 0), 0);

  // ── Handle label scan ──
  const handleScanFile = async (file) => {
    if (!file) return;
    setScanError(null);
    setScanning(true);
    try {
      const dataUrl = await resizeImage(file, 500, 0.65);
      const info    = await scanLabel(dataUrl);

      // Store a smaller thumbnail for display
      const thumb = await resizeImage(file, 400, 0.65);

      setEditing(prev => ({
        ...prev,
        name:     info.name     || prev.name,
        producer: info.producer || prev.producer,
        year:     info.year     || prev.year,
        type:     WINE_TYPES.includes(info.type) ? info.type : prev.type,
        region:   info.region   || prev.region,
        grape:    info.grape    || prev.grape,
        notes:    info.notes    || prev.notes,
        price:    info.price != null ? String(info.price) : prev.price,
        photo:    thumb,
      }));
      showToast("✨ Etichetta riconosciuta con successo!");
    } catch (err) {
      console.error(err);
      setScanError("Non sono riuscito a leggere l'etichetta. Riprova con una foto più nitida.");
    } finally {
      setScanning(false);
    }
  };

  // Bevi una bottiglia: -1 quantità, rimuove l'ultima posizione
  const handleDrinkOne = (wine) => {
    const newQty = wine.quantity - 1;
    const newPositions = (wine.positions || []).slice(0, -1);
    if (newQty <= 0) {
      // ultima bottiglia: chiedi conferma eliminazione
      setModal(null);
      setDeleteConfirm(wine);
      return;
    }
    const updated = { ...wine, quantity: newQty, positions: newPositions };
    saveWines(wines.map(w => w.id === wine.id ? updated : w));
    setEditing(updated);
    showToast(`Una bottiglia di "${wine.name}" bevuta — ne rimangono ${newQty}`);
  };

  // Approfondisci: chiama Claude, salva automaticamente il risultato nella bottiglia
  const handleEnrich = async (wine) => {
    setEnriching(true);
    setEnrichData(null);
    setEnrichError(null);
    try {
      const resp = await fetch("/.netlify/functions/enrich-wine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wine.name, producer: wine.producer, year: wine.year,
          type: wine.type, region: wine.region, grape: wine.grape,
        }),
      });
      if (!resp.ok) throw new Error(`Errore ${resp.status}`);
      const data = await resp.json();
      setEnrichData(data);
      // Salva automaticamente l'analisi nella bottiglia
      const updated = { ...wine, enrichment: data };
      saveWines(wines.map(w => w.id === wine.id ? updated : w));
      setEditing(updated);
      showToast("Analisi salvata nella scheda");
    } catch (err) {
      setEnrichError("Non sono riuscito a recuperare le informazioni. Riprova.");
    } finally {
      setEnriching(false);
    }
  };

  const handleSaveWine = () => {
    if (!editing.name.trim()) return;
    if (modal === "add") {
      saveWines([...wines, { ...editing, id: nextWineId.current++ }]);
      showToast(`"${editing.name}" aggiunto`);
    } else {
      saveWines(wines.map(w => w.id === editing.id ? editing : w));
      showToast(`"${editing.name}" aggiornato`);
    }
    setModal(null);
  };

  const handleSaveRack = () => {
    if (!editingRack.name.trim()) return;
    if (rackModal === "add") {
      saveRacks([...racks, { ...editingRack, id: nextRackId.current++, rows: parseInt(editingRack.rows)||4, cols: parseInt(editingRack.cols)||6 }]);
      showToast(`Scaffale "${editingRack.name}" creato`);
    } else {
      const u = { ...editingRack, rows: parseInt(editingRack.rows)||4, cols: parseInt(editingRack.cols)||6 };
      saveRacks(racks.map(r => r.id === u.id ? u : r));
      showToast(`Scaffale "${u.name}" aggiornato`);
    }
    setRackModal(null);
  };

  const handleDeleteRack = (rack) => {
    saveRacks(racks.filter(r => r.id !== rack.id));
    saveWines(wines.map(w => w.rackId === rack.id ? { ...w, rackId: null, positions: [] } : w));
    setDeleteRackConfirm(null);
    showToast(`Scaffale "${rack.name}" eliminato`);
  };

  const getWineAtPosition = (rackId, pos) => wines.find(w => w.rackId === rackId && (w.positions||[]).includes(pos));

  const C = {
    bg: "#2e1f0f", surface: "#3e2a16", surface2: "#4e3520",
    border: "#7a5535", borderLight: "#9a7550",
    gold: "#c9953a", goldLight: "#e0b85a",
    text: "#f2e0c5", textMuted: "#c0a07a", textFaint: "#907050",
  };

  const inputStyle = {
    background: C.bg, border: `1px solid ${C.border}`, borderRadius: 7,
    color: C.text, padding: "11px 14px", width: "100%",
    fontFamily: "'Cormorant Garamond', serif", fontSize: 17, outline: "none",
    transition: "border-color 0.15s",
  };
  const labelStyle = {
    color: C.textFaint, fontSize: 13, letterSpacing: 1.2,
    fontFamily: "'Cinzel', serif", textTransform: "uppercase", marginBottom: 6, display: "block",
  };

  const MiniRackMap = ({ rack, highlightPositions }) => (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 3, marginBottom: 3, marginLeft: 28 }}>
        {Array.from({ length: rack.cols }, (_, c) => (
          <div key={c} style={{ width: 40, textAlign: "center", fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{c + 1}</div>
        ))}
      </div>
      {Array.from({ length: rack.rows }, (_, r) => (
        <div key={r} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
          <div style={{ width: 24, textAlign: "center", fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>{ROW_LABELS[r]}</div>
          {Array.from({ length: rack.cols }, (_, c) => {
            const pos = `${ROW_LABELS[r]}${c + 1}`;
            const isThis = (highlightPositions||[]).includes(pos);
            const occupant = wines.find(w => w.rackId === rack.id && (w.positions||[]).includes(pos));
            const isOther = occupant && occupant.id !== editing?.id;
            const otc = isOther ? typeColors[occupant.type] : null;
            return (
              <div key={c} title={isThis ? "Qui!" : isOther ? occupant.name : pos} style={{
                width: 40, height: 32, borderRadius: 5,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 11, fontFamily: "'Cinzel', serif",
                background: isThis ? C.gold : isOther ? `${otc.badge}bb` : C.surface,
                border: isThis ? `2px solid ${C.goldLight}` : isOther ? `1px solid ${otc.bar}` : `1px dashed ${C.border}`,
                color: isThis ? "#1a0800" : isOther ? otc.text : C.textFaint,
                fontWeight: isThis ? 900 : 400,
                boxShadow: isThis ? `0 0 10px ${C.gold}99` : "none",
              }}>
                {isThis ? "★" : isOther ? "●" : ""}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  // Multi-position picker: ogni cella selezionata = una bottiglia
  const PositionGrid = ({ rack, values, onChange, maxSelections }) => {
    const togglePos = (pos) => {
      const occupant = getWineAtPosition(rack.id, pos);
      const isSelf = occupant?.id === editing?.id;
      if (occupant && !isSelf) return; // occupata da altro vino
      const selected = values.includes(pos);
      if (selected) {
        onChange(values.filter(p => p !== pos));
      } else {
        if (values.length >= maxSelections) return; // raggiunto il limite
        onChange([...values, pos]);
      }
    };
    return (
      <div style={{ overflowX: "auto", marginTop: 10 }}>
        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8, fontStyle: "italic" }}>
          Seleziona fino a {maxSelections} celle ({values.length}/{maxSelections} selezionate) — una per bottiglia
        </div>
        <div style={{ display: "flex", gap: 3, marginBottom: 3, marginLeft: 28 }}>
          {Array.from({ length: rack.cols }, (_, c) => (
            <div key={c} style={{ width: 40, textAlign: "center", fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{c + 1}</div>
          ))}
        </div>
        {Array.from({ length: rack.rows }, (_, r) => (
          <div key={r} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
            <div style={{ width: 24, fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif", fontWeight: 700, textAlign: "center" }}>{ROW_LABELS[r]}</div>
            {Array.from({ length: rack.cols }, (_, c) => {
              const pos = `${ROW_LABELS[r]}${c + 1}`;
              const occupant = getWineAtPosition(rack.id, pos);
              const isSelf = occupant?.id === editing?.id;
              const isOtherWine = occupant && !isSelf;
              const selected = values.includes(pos);
              const atLimit = values.length >= maxSelections && !selected;
              const disabled = isOtherWine || atLimit;
              return (
                <div key={c} onClick={() => !disabled && togglePos(pos)} style={{
                  width: 40, height: 32, borderRadius: 5,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: disabled ? "not-allowed" : "pointer", fontSize: 10, fontFamily: "'Cinzel', serif",
                  background: selected ? C.gold : isOtherWine ? "rgba(150,50,50,0.3)" : atLimit ? "rgba(80,80,80,0.2)" : C.surface,
                  border: selected ? `2px solid ${C.goldLight}` : isOtherWine ? "1px solid rgba(180,60,60,0.5)" : `1px dashed ${C.border}`,
                  color: selected ? "#1a0800" : isOtherWine ? "#c07070" : atLimit ? C.textFaint : C.textFaint,
                  fontWeight: selected ? 700 : 400, opacity: atLimit ? 0.4 : 1, transition: "all 0.12s",
                }} title={isOtherWine ? `Occupata: ${occupant.name}` : selected ? `Rimuovi ${pos}` : atLimit ? "Limite raggiunto" : pos}>
                  {selected ? "✓" : isOtherWine ? "●" : pos}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Cormorant Garamond', serif", color: C.text, fontSize: 16 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input, select, textarea { color-scheme: dark; }
        input::placeholder, textarea::placeholder { color: ${C.textFaint}; }
        select option { background: ${C.surface}; color: ${C.text}; }
        input:focus, select:focus, textarea:focus { border-color: ${C.gold} !important; box-shadow: 0 0 0 2px rgba(201,149,58,0.14); }
        .wine-card { transition: transform 0.18s, box-shadow 0.18s; }
        .wine-card:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(0,0,0,0.4) !important; }
        .btn-gold { background: linear-gradient(135deg, #a07828, ${C.gold}, #a07828); color: #1a0800; border: none; border-radius: 8px; padding: 12px 24px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 14px; letter-spacing: 1.5px; font-weight: 700; transition: opacity 0.15s, transform 0.12s; white-space: nowrap; }
        .btn-gold:hover { opacity: 0.88; transform: translateY(-1px); }
        .btn-ghost { background: transparent; color: ${C.textMuted}; border: 1px solid ${C.border}; border-radius: 8px; padding: 11px 22px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 14px; letter-spacing: 1px; transition: border-color 0.15s, color 0.15s; white-space: nowrap; }
        .btn-ghost:hover { border-color: ${C.gold}; color: ${C.gold}; }
        .btn-sm { background: ${C.surface2}; color: ${C.textMuted}; border: 1px solid ${C.border}; border-radius: 7px; padding: 8px 16px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 1px; transition: all 0.15s; }
        .btn-sm:hover { color: ${C.gold}; border-color: ${C.gold}; }
        .btn-danger { background: transparent; color: #c07070; border: 1px solid #804040; border-radius: 8px; padding: 10px 16px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 1px; transition: background 0.15s; }
        .btn-danger:hover { background: rgba(180,60,60,0.15); }
        .tab-btn { background: none; border: 1px solid transparent; cursor: pointer; padding: 8px 16px; border-radius: 20px; font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 1px; transition: all 0.15s; }
        .nav-btn { background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; padding: 12px 22px; font-family: 'Cinzel', serif; font-size: 14px; letter-spacing: 2px; transition: all 0.15s; color: ${C.textFaint}; }
        .nav-btn.active { color: ${C.gold}; border-bottom-color: ${C.gold}; }
        .nav-btn:hover:not(.active) { color: ${C.textMuted}; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 16px; backdrop-filter: blur(4px); }
        .modal-box { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; width: 100%; max-width: 620px; max-height: 94vh; overflow-y: auto; box-shadow: 0 30px 80px rgba(0,0,0,0.6); animation: fadeUp 0.22s ease; }
        @keyframes fadeUp { from { opacity:0; transform: translateY(18px) scale(0.97); } to { opacity:1; transform: none; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .rack-card { background: ${C.surface2}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .action-btn { flex: 1; background: none; border: none; cursor: pointer; padding: 10px; font-family: 'Cinzel', serif; font-size: 13px; letter-spacing: 1px; transition: color 0.15s, background 0.15s; }

        /* scan button */
        .btn-scan {
          display: flex; align-items: center; justify-content: center; gap: 10px;
          width: 100%; padding: 16px; border-radius: 10px; cursor: pointer;
          font-family: 'Cinzel', serif; font-size: 15px; font-weight: 600; letter-spacing: 1.5px;
          border: 2px dashed ${C.gold};
          background: rgba(201,149,58,0.07);
          color: ${C.gold}; transition: all 0.2s;
        }
        .btn-scan:hover { background: rgba(201,149,58,0.14); border-style: solid; }
        .btn-scan:disabled { opacity: 0.5; cursor: not-allowed; }
        .spinner { width: 18px; height: 18px; border: 2px solid rgba(201,149,58,0.3); border-top-color: ${C.gold}; border-radius: 50%; animation: spin 0.8s linear infinite; }
      `}</style>

      {/* ── HEADER ── */}
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "22px 32px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 34 }}>🍷</span>
          <div>
            <h1 style={{ fontFamily: "'Cinzel', serif", fontSize: 24, fontWeight: 700, color: C.gold, letterSpacing: 3 }}>LA MIA CANTINA</h1>
            <p style={{ fontSize: 13, color: C.textFaint, letterSpacing: 2, fontFamily: "'Cinzel', serif", marginTop: 2 }}>CATALOGO VINI</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          {[["BOTTIGLIE", totalBottles], ["ETICHETTE", wines.length], ["SCAFFALI", racks.length]].map(([l, v]) => (
            <div key={l} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 26, fontWeight: 300, color: C.gold }}>{v}</div>
              <div style={{ fontSize: 13, color: C.textFaint, letterSpacing: 1.5, fontFamily: "'Cinzel', serif" }}>{l}</div>
            </div>
          ))}
          {totalValue > 0 && <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 26, fontWeight: 300, color: C.gold }}>€{totalValue.toFixed(0)}</div>
            <div style={{ fontSize: 13, color: C.textFaint, letterSpacing: 1.5, fontFamily: "'Cinzel', serif" }}>VALORE</div>
          </div>}
          <button className="btn-gold" onClick={() => { setEditing(emptyWine()); setScanError(null); setModal("add"); }}>+ AGGIUNGI VINO</button>
        </div>
      </header>

      {/* ── NAV ── */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 32px", display: "flex" }}>
        {[["catalog","📋  CATALOGO"],["racks","🗄  SCAFFALI"]].map(([v,l]) => (
          <button key={v} className={`nav-btn ${view===v?"active":""}`} onClick={() => setView(v)}>{l}</button>
        ))}
      </div>

      {/* ══════ CATALOG VIEW ══════ */}
      {view === "catalog" && <>
        <div style={{ padding: "18px 32px", background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 220, position: "relative" }}>
            <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: C.textFaint, fontSize: 16 }}>🔍</span>
            <input placeholder="Cerca nome, produttore, vitigno…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, paddingLeft: 40 }} />
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {["Tutti",...WINE_TYPES].map(t => (
              <button key={t} className="tab-btn" onClick={() => setFilterType(t)} style={{ color: filterType===t?C.gold:C.textFaint, background: filterType===t?"rgba(201,149,58,0.14)":"none", border: filterType===t?`1px solid rgba(201,149,58,0.4)`:"1px solid transparent" }}>{t.toUpperCase()}</button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>ORDINA</span>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inputStyle, width: "auto", fontSize: 15, padding: "9px 12px" }}>
              <option value="name">Nome</option>
              <option value="year">Annata</option>
              <option value="rating">Valutazione</option>
              <option value="quantity">Quantità</option>
            </select>
            {sortBy === "year" && (
              <button onClick={() => setSortDir(d => d==="asc"?"desc":"asc")} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.gold, cursor: "pointer", padding: "9px 14px", fontFamily: "'Cinzel', serif", fontSize: 14, whiteSpace: "nowrap" }}>
                {sortDir==="asc" ? "↑ Più vecchi" : "↓ Più recenti"}
              </button>
            )}
          </div>
        </div>

        <div style={{ padding: "28px 32px" }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.4 }}>🍷</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 15 }}>{wines.length===0?"LA CANTINA È VUOTA":"NESSUN RISULTATO"}</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 18 }}>
              {filtered.map(wine => {
                const tc = typeColors[wine.type] || { bar: "#888" };
                const rack = racks.find(r => r.id === wine.rackId);
                return (
                  <div key={wine.id} className="wine-card" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", boxShadow: "0 3px 12px rgba(0,0,0,0.25)" }}
                    onClick={() => { setEditing({...wine}); setEnrichData(null); setEnrichError(null); setModal("view"); }}>
                    <div style={{ height: 3, background: `linear-gradient(90deg, ${tc.bar}, ${C.gold})` }} />

                    {/* Photo strip */}
                    {wine.photo && (
                      <div style={{ height: 140, overflow: "hidden", position: "relative" }}>
                        <img src={wine.photo} alt={wine.name} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top" }} />
                        <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to bottom, transparent 50%, rgba(46,31,15,0.85) 100%)" }} />
                      </div>
                    )}

                    <div style={{ padding: "15px 18px 13px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 9 }}>
                        <TypeBadge type={wine.type} />
                        <span style={{ fontSize: 15, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>{wine.year}</span>
                      </div>
                      <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, fontWeight: 600, color: C.text, marginBottom: 4, lineHeight: 1.3 }}>{wine.name}</h3>
                      <p style={{ fontSize: 15, color: C.textMuted, fontStyle: "italic", marginBottom: 9 }}>{wine.producer}</p>
                      <div style={{ display: "flex", gap: 12, marginBottom: 9, fontSize: 14, color: C.textFaint, flexWrap: "wrap" }}>
                        {wine.region && <span>📍 {wine.region}</span>}
                        {wine.grape  && <span>🍇 {wine.grape}</span>}
                      </div>
                      {rack && (wine.positions||[]).length > 0 && (
                        <div style={{ marginBottom: 9, display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(201,149,58,0.1)", border: `1px solid rgba(201,149,58,0.25)`, borderRadius: 7, padding: "5px 11px" }}>
                          <span style={{ fontSize: 13, color: C.textFaint }}>🗄</span>
                          <span style={{ fontSize: 14, color: C.textMuted, fontFamily: "'Cinzel', serif" }}>{rack.name}</span>
                          <span style={{ fontSize: 15, color: C.gold, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>{(wine.positions||[]).join(", ")}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <StarRating value={wine.rating} readonly />
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          {wine.price && <span style={{ fontSize: 15, color: C.textMuted }}>€{wine.price}</span>}
                          <span style={{ background: wine.quantity===0?"rgba(180,60,60,0.2)":wine.quantity<=2?"rgba(180,150,60,0.2)":"rgba(60,150,60,0.2)", color: wine.quantity===0?"#d07070":wine.quantity<=2?"#c0b040":"#70c070", padding: "4px 12px", borderRadius: 20, fontSize: 14, fontFamily: "'Cinzel', serif", fontWeight: 600 }}>{wine.quantity} bt</span>
                        </div>
                      </div>
                    </div>
                    <div style={{ borderTop: `1px solid ${C.bg}`, display: "flex" }}>
                      {[["✏ MODIFICA", () => { setEditing({...wine}); setScanError(null); setModal("edit"); }, false],
                        ["✕ ELIMINA",  () => setDeleteConfirm(wine), true]].map(([label,fn,danger]) => (
                        <button key={label} className="action-btn" style={{ color: danger?"#9a5050":C.textFaint, borderRight: !danger?`1px solid ${C.bg}`:"none" }}
                          onClick={e => { e.stopPropagation(); fn(); }}
                          onMouseEnter={e => { e.currentTarget.style.color = danger?"#d07070":C.gold; e.currentTarget.style.background="rgba(0,0,0,0.1)"; }}
                          onMouseLeave={e => { e.currentTarget.style.color = danger?"#9a5050":C.textFaint; e.currentTarget.style.background="none"; }}
                        >{label}</button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </>}

      {/* ══════ RACKS VIEW ══════ */}
      {view === "racks" && (
        <div style={{ padding: "28px 32px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
            <div>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, letterSpacing: 2, marginBottom: 7 }}>I MIEI SCAFFALI</h2>
              <p style={{ fontSize: 15, color: C.textMuted, fontStyle: "italic" }}>Ogni cella è una posizione A1, B3… Clicca su una bottiglia per i dettagli.</p>
            </div>
            <button className="btn-gold" onClick={() => { setEditingRack(emptyRack()); setRackModal("add"); }}>+ NUOVO SCAFFALE</button>
          </div>
          {racks.length === 0 && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.4 }}>🗄</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 15 }}>NESSUNO SCAFFALE CONFIGURATO</p>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            {racks.map(rack => {
              const occ = wines.filter(w => w.rackId === rack.id);
              return (
                <div key={rack.id} className="rack-card">
                  <div style={{ padding: "17px 22px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.text, letterSpacing: 1 }}>{rack.name}</h3>
                      <p style={{ fontSize: 14, color: C.textFaint, marginTop: 4 }}>{rack.rows} file ({ROW_LABELS[0]}–{ROW_LABELS[rack.rows-1]}) × {rack.cols} colonne · {occ.length}/{rack.rows*rack.cols} occupate</p>
                    </div>
                    <div style={{ display: "flex", gap: 9 }}>
                      <button className="btn-sm" onClick={() => { setEditingRack({...rack}); setRackModal("edit"); }}>✏ Modifica</button>
                      <button className="btn-danger" onClick={() => setDeleteRackConfirm(rack)}>✕</button>
                    </div>
                  </div>
                  <div style={{ padding: "20px 22px", overflowX: "auto" }}>
                    <div style={{ display: "flex", gap: 4, marginBottom: 4, marginLeft: 32 }}>
                      {Array.from({length:rack.cols},(_,c)=>(
                        <div key={c} style={{ width:56, textAlign:"center", fontSize:13, color:C.textFaint, fontFamily:"'Cinzel', serif", fontWeight:600 }}>{c+1}</div>
                      ))}
                    </div>
                    {Array.from({length:rack.rows},(_,r)=>(
                      <div key={r} style={{ display:"flex", alignItems:"center", gap:4, marginBottom:4 }}>
                        <div style={{ width:28, textAlign:"center", fontSize:14, color:C.textFaint, fontFamily:"'Cinzel', serif", fontWeight:700 }}>{ROW_LABELS[r]}</div>
                        {Array.from({length:rack.cols},(_,c)=>{
                          const pos = `${ROW_LABELS[r]}${c+1}`;
                          const wine = getWineAtPosition(rack.id, pos);
                          const tc = wine?typeColors[wine.type]:null;
                          return (
                            <div key={c} onClick={()=>wine&&(setEditing({...wine}),setModal("view"))}
                              title={wine?`${wine.name} (${wine.year})`:`Libera — ${pos}`}
                              style={{ width:56,height:46,borderRadius:7,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:wine?"pointer":"default",background:wine?`${tc.badge}dd`:C.surface,border:wine?`1px solid ${tc.bar}`:`1px dashed ${C.border}`,color:wine?tc.text:C.textFaint,transition:"all 0.12s",fontSize:10,fontFamily:"'Cinzel', serif",overflow:"hidden" }}
                              onMouseEnter={e=>{if(wine){e.currentTarget.style.transform="scale(1.06)";e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.4)";}else{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}}
                              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";e.currentTarget.style.borderColor=wine?tc.bar:C.border;e.currentTarget.style.color=wine?tc.text:C.textFaint;}}
                            >
                              {wine?(
                                <>
                                  <span style={{fontWeight:700,lineHeight:1.1,textAlign:"center",padding:"0 2px",maxWidth:"100%",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis",fontSize:9}}>{wine.name.length>7?wine.name.slice(0,6)+"…":wine.name}</span>
                                  <span style={{opacity:0.75,fontSize:9,marginTop:1}}>{wine.year}</span>
                                </>
                              ):<span style={{opacity:0.3,fontSize:11}}>{pos}</span>}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {occ.length>0&&(
                      <div style={{marginTop:14,display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
                        <span style={{fontSize:13,color:C.textFaint,fontFamily:"'Cinzel', serif",letterSpacing:1}}>LEGENDA:</span>
                        {[...new Set(occ.map(w=>w.type))].map(type=>{const c=typeColors[type];return(
                          <div key={type} style={{display:"flex",alignItems:"center",gap:6}}>
                            <div style={{width:14,height:14,background:c.badge,border:`1px solid ${c.bar}`,borderRadius:3}}/>
                            <span style={{fontSize:13,color:C.textFaint,fontFamily:"'Cinzel', serif"}}>{type}</span>
                          </div>
                        );})}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ══════ MODAL ADD / EDIT WINE ══════ */}
      {(modal==="add"||modal==="edit") && editing && (
        <div className="modal-overlay" onClick={()=>setModal(null)}>
          <div className="modal-box" onClick={e=>e.stopPropagation()}>
            <div style={{padding:"22px 26px 18px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <h2 style={{fontFamily:"'Cinzel', serif",fontSize:17,color:C.gold,letterSpacing:2}}>{modal==="add"?"AGGIUNGI VINO":"MODIFICA VINO"}</h2>
              <button onClick={()=>setModal(null)} style={{background:"none",border:"none",color:C.textFaint,cursor:"pointer",fontSize:20,lineHeight:1}}>✕</button>
            </div>
            <div style={{padding:"22px 26px",display:"flex",flexDirection:"column",gap:20}}>

              {/* ── SCAN SECTION ── */}
              <div style={{background:C.bg,borderRadius:10,padding:"18px",border:`1px solid ${C.border}`}}>
                <p style={{...labelStyle, marginBottom:12}}>📷 Riconosci dall'Etichetta</p>

                {/* Preview foto */}
                {editing.photo && (
                  <div style={{marginBottom:14,position:"relative",borderRadius:8,overflow:"hidden",maxHeight:200,display:"flex",alignItems:"center",justifyContent:"center",background:"#000"}}>
                    <img src={editing.photo} alt="etichetta" style={{maxHeight:200,maxWidth:"100%",objectFit:"contain"}}/>
                    <button onClick={()=>setEditing(v=>({...v,photo:null}))}
                      style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",border:"none",color:"#fff",borderRadius:"50%",width:28,height:28,cursor:"pointer",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                  </div>
                )}

                <input ref={scanInputRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
                  onChange={e => { const f=e.target.files?.[0]; if(f) handleScanFile(f); e.target.value=""; }} />

                <button className="btn-scan" disabled={scanning} onClick={()=>scanInputRef.current?.click()}>
                  {scanning ? (
                    <><div className="spinner"/><span>Analisi in corso…</span></>
                  ) : (
                    <><span style={{fontSize:20}}>📷</span><span>{editing.photo?"Scansiona di nuovo":"Fotografa l'etichetta"}</span></>
                  )}
                </button>

                {scanning && (
                  <p style={{fontSize:13,color:C.textMuted,marginTop:10,textAlign:"center",fontStyle:"italic"}}>
                    Sto leggendo l'etichetta e cercando informazioni sul vino…
                  </p>
                )}
                {scanError && (
                  <p style={{fontSize:13,color:"#c07070",marginTop:10,textAlign:"center"}}>{scanError}</p>
                )}
                {!scanning && !scanError && (
                  <p style={{fontSize:12,color:C.textFaint,marginTop:8,textAlign:"center"}}>
                    Fotografa l'etichetta — i campi verranno compilati automaticamente
                  </p>
                )}
              </div>

              {/* ── FORM ── */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:15}}>
                <div style={{gridColumn:"1/-1"}}>
                  <label style={labelStyle}>Nome Vino *</label>
                  <input style={inputStyle} value={editing.name} onChange={e=>setEditing(v=>({...v,name:e.target.value}))} placeholder="es. Barolo Riserva"/>
                </div>
                <div>
                  <label style={labelStyle}>Produttore</label>
                  <input style={inputStyle} value={editing.producer} onChange={e=>setEditing(v=>({...v,producer:e.target.value}))} placeholder="es. Giacomo Conterno"/>
                </div>
                <div>
                  <label style={labelStyle}>Annata</label>
                  <input style={inputStyle} type="number" value={editing.year} onChange={e=>setEditing(v=>({...v,year:parseInt(e.target.value)||v.year}))}/>
                </div>
                <div>
                  <label style={labelStyle}>Tipologia</label>
                  <select style={inputStyle} value={editing.type} onChange={e=>setEditing(v=>({...v,type:e.target.value}))}>
                    {WINE_TYPES.map(t=><option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Regione</label>
                  <select style={inputStyle} value={editing.region} onChange={e=>setEditing(v=>({...v,region:e.target.value}))}>
                    {REGIONS.map(r=><option key={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Vitigno</label>
                  <input style={inputStyle} value={editing.grape} onChange={e=>setEditing(v=>({...v,grape:e.target.value}))} placeholder="es. Nebbiolo"/>
                </div>
                <div>
                  <label style={labelStyle}>Quantità (bt)</label>
                  <input style={inputStyle} type="number" min="0" value={editing.quantity} onChange={e=>setEditing(v=>({...v,quantity:parseInt(e.target.value)||0}))}/>
                </div>
                <div>
                  <label style={labelStyle}>Prezzo (€)</label>
                  <input style={inputStyle} type="number" min="0" value={editing.price} onChange={e=>setEditing(v=>({...v,price:e.target.value}))} placeholder="es. 45"/>
                </div>

                {/* Shelf picker */}
                <div style={{gridColumn:"1/-1",background:C.bg,borderRadius:9,padding:"16px 18px",border:`1px solid ${C.border}`}}>
                  <p style={{...labelStyle,marginBottom:12}}>🗄 Posizione nello Scaffale</p>
                  <div style={{marginBottom:10}}>
                    <label style={labelStyle}>Scaffale</label>
                    <select style={inputStyle} value={editing.rackId||""} onChange={e=>setEditing(v=>({...v,rackId:e.target.value?parseInt(e.target.value):null,positions:[]}))}>
                      <option value="">— Nessuno —</option>
                      {racks.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  {editing.rackId&&(()=>{
                    const rack=racks.find(r=>r.id===editing.rackId);
                    if(!rack) return null;
                    return(
                      <PositionGrid rack={rack} values={editing.positions||[]} maxSelections={editing.quantity||1}
                        onChange={ps=>setEditing(v=>({...v,positions:ps}))}/>
                    );
                  })()}
                </div>

                <div style={{gridColumn:"1/-1"}}>
                  <label style={labelStyle}>Valutazione</label>
                  <StarRating value={editing.rating} onChange={r=>setEditing(v=>({...v,rating:r}))}/>
                </div>
                <div style={{gridColumn:"1/-1"}}>
                  <label style={labelStyle}>Note di degustazione</label>
                  <textarea style={{...inputStyle,minHeight:80,resize:"vertical",lineHeight:1.6}}
                    value={editing.notes} onChange={e=>setEditing(v=>({...v,notes:e.target.value}))}
                    placeholder="Aromi, struttura, abbinamenti…"/>
                </div>
                <div style={{gridColumn:"1/-1",display:"flex",gap:12,justifyContent:"flex-end",paddingTop:4}}>
                  <button className="btn-ghost" onClick={()=>setModal(null)}>ANNULLA</button>
                  <button className="btn-gold" onClick={handleSaveWine}>{modal==="add"?"AGGIUNGI":"SALVA"}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════ MODAL VIEW WINE ══════ */}
      {modal==="view" && editing && (()=>{
        const tc=typeColors[editing.type]||{bar:"#888"};
        const rack=racks.find(r=>r.id===editing.rackId);
        return(
          <div className="modal-overlay" onClick={()=>setModal(null)}>
            <div className="modal-box" onClick={e=>e.stopPropagation()}>
              <div style={{height:4,background:`linear-gradient(90deg, ${tc.bar}, ${C.gold})`,borderRadius:"14px 14px 0 0"}}/>

              {/* Photo hero */}
              {editing.photo && (
                <div style={{height:220,overflow:"hidden",position:"relative",display:"flex",alignItems:"center",justifyContent:"center",background:"#1a0f08"}}>
                  <img src={editing.photo} alt={editing.name} style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain"}}/>
                  <div style={{position:"absolute",inset:0,background:"linear-gradient(to bottom, transparent 40%, rgba(62,42,22,0.95) 100%)"}}/>
                  <div style={{position:"absolute",bottom:14,left:22,right:22}}>
                    <TypeBadge type={editing.type}/>
                  </div>
                  <div style={{position:"absolute",top:14,right:18,fontSize:28,fontWeight:300,color:C.gold,fontFamily:"'Cinzel', serif"}}>{editing.year}</div>
                </div>
              )}

              <div style={{padding:"22px 26px"}}>
                {!editing.photo && (
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                    <TypeBadge type={editing.type}/>
                    <span style={{fontSize:30,fontWeight:300,color:C.gold,fontFamily:"'Cinzel', serif"}}>{editing.year}</span>
                  </div>
                )}
                <h2 style={{fontFamily:"'Cinzel', serif",fontSize:24,color:C.text,marginBottom:5,marginTop:editing.photo?8:0}}>{editing.name}</h2>
                <p style={{fontSize:17,color:C.textMuted,fontStyle:"italic",marginBottom:18}}>{editing.producer}</p>

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
                  {[
                    ["📍 Regione", editing.region, false],
                    ["🍇 Vitigno", editing.grape||"—", false],
                    ["🍾 Bottiglie", editing.quantity, false],
                    ["💰 Prezzo", editing.price?`€${editing.price}`:"—", false],
                    ...(rack?[["🗄 Scaffale",rack.name,false]]:[]),
                    ...((editing.positions||[]).length?[["📌 Posizioni",(editing.positions||[]).join(", "),true]]:[]),
                  ].map(([l,v,highlight])=>(
                    <div key={l} style={{background:C.bg,borderRadius:8,padding:"11px 14px"}}>
                      <div style={{fontSize:13,color:C.textFaint,letterSpacing:1,fontFamily:"'Cinzel', serif",marginBottom:4}}>{l}</div>
                      <div style={{fontSize:highlight?22:16,color:highlight?C.gold:C.text,fontFamily:highlight?"'Cinzel', serif":"inherit",fontWeight:highlight?700:400}}>{v}</div>
                    </div>
                  ))}
                </div>

                {rack&&(editing.positions||[]).length>0&&(
                  <div style={{background:C.bg,borderRadius:9,padding:"14px 16px",marginBottom:16,border:`1px solid ${C.border}`}}>
                    <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:10}}>POSIZIONE NELLO SCAFFALE — {rack.name}</div>
                    <MiniRackMap rack={rack} highlightPositions={editing.positions||[]}/>
                  </div>
                )}

                <div style={{marginBottom:16}}>
                  <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:7}}>VALUTAZIONE</div>
                  <StarRating value={editing.rating} readonly/>
                </div>
                {editing.notes&&(
                  <div style={{background:C.bg,borderRadius:8,padding:"14px 16px",borderLeft:`2px solid ${C.border}`,marginBottom:16}}>
                    <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:6}}>NOTE DI DEGUSTAZIONE</div>
                    <p style={{fontSize:16,color:C.textMuted,lineHeight:1.7,fontStyle:"italic"}}>{editing.notes}</p>
                  </div>
                )}
                {/* ── APPROFONDISCI ── */}
                {(()=>{
                  // Mostra i dati salvati nella bottiglia, o quelli appena scaricati
                  const displayData = enrichData || editing.enrichment || null;
                  return (
                    <div style={{background:C.bg,borderRadius:9,padding:"14px 16px",marginBottom:16,border:`1px solid ${C.border}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom: displayData||enriching||enrichError ? 16 : 0}}>
                        <div>
                          <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif"}}>
                            🔍 ANALISI DEL VINO
                          </div>
                          {editing.enrichment && !enriching && (
                            <div style={{fontSize:11,color:C.textFaint,marginTop:3,fontStyle:"italic"}}>
                              Analisi salvata · clicca per aggiornare
                            </div>
                          )}
                        </div>
                        <button onClick={()=>handleEnrich(editing)} disabled={enriching}
                          style={{
                            background: enriching ? "rgba(201,149,58,0.1)" : "linear-gradient(135deg, #a07828, #c9953a)",
                            color: enriching ? C.gold : "#1a0800",
                            border: enriching ? `1px solid ${C.gold}` : "none",
                            borderRadius:7, padding:"8px 16px", cursor: enriching ? "not-allowed" : "pointer",
                            fontFamily:"'Cinzel', serif", fontSize:12, letterSpacing:1.5, fontWeight:700,
                            display:"flex", alignItems:"center", gap:8, transition:"opacity 0.15s",
                          }}>
                          {enriching
                            ? <><div style={{width:14,height:14,border:"2px solid rgba(201,149,58,0.3)",borderTopColor:C.gold,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/> Analisi in corso…</>
                            : editing.enrichment ? "🔄 Rianalizza" : "✨ Analizza"}
                        </button>
                      </div>

                      {enriching && (
                        <p style={{fontSize:13,color:C.textMuted,fontStyle:"italic"}}>
                          Sto raccogliendo informazioni approfondite su {editing.name}…
                        </p>
                      )}

                      {enrichError && (
                        <p style={{fontSize:13,color:"#c07070"}}>{enrichError}</p>
                      )}

                      {displayData && !enriching && (
                        <div style={{display:"flex",flexDirection:"column",gap:16}}>
                          {[
                            ["🍇 Il Vitigno", displayData.grapeProfile],
                            ["👃 Sentori & Degustazione", displayData.tastingNotes],
                            ["🌍 Territorio & Denominazione", displayData.territory],
                            ["⏳ Invecchiamento", displayData.aging],
                            ["🍽 Abbinamenti Gastronomici", displayData.foodPairing],
                            ["💡 Lo sapevi?", displayData.curiosity],
                          ].filter(([,v]) => v).map(([label, text]) => (
                            <div key={label} style={{borderLeft:`2px solid ${C.border}`,paddingLeft:12}}>
                              <div style={{fontSize:12,color:C.gold,fontFamily:"'Cinzel', serif",letterSpacing:1,marginBottom:5,fontWeight:700}}>
                                {label}
                              </div>
                              <p style={{fontSize:15,color:C.textMuted,lineHeight:1.8,fontStyle:"italic",margin:0}}>
                                {text}
                              </p>
                            </div>
                          ))}

                          {/* Bottone per copiare solo i sentori nelle note */}
                          {displayData.tastingNotes && (
                            <button onClick={()=>{
                              const updated = {...editing, notes: displayData.tastingNotes};
                              saveWines(wines.map(w => w.id === editing.id ? updated : w));
                              setEditing(updated);
                              showToast("Note di degustazione aggiornate");
                            }} style={{
                              alignSelf:"flex-start", background:"transparent",
                              border:`1px solid ${C.border}`, borderRadius:6,
                              color:C.textMuted, cursor:"pointer", padding:"7px 14px",
                              fontFamily:"'Cinzel', serif", fontSize:12, letterSpacing:1,
                              transition:"all 0.15s",
                            }}
                              onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}
                              onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textMuted;}}
                            >
                              📝 Copia sentori nelle note
                            </button>
                          )}
                        </div>
                      )}

                      {!displayData && !enriching && !enrichError && (
                        <p style={{fontSize:13,color:C.textFaint,fontStyle:"italic"}}>
                          Clicca "Analizza" per ricevere informazioni approfondite su vitigno, sentori, territorio e abbinamenti. L'analisi viene salvata automaticamente.
                        </p>
                      )}
                    </div>
                  );
                })()}

                <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
                  <button className="btn-danger" onClick={()=>{setModal(null);setDeleteConfirm(editing);}}>ELIMINA</button>
                  <button className="btn-ghost" onClick={()=>{setModal(null);setEnrichData(null);setEnrichError(null);}}>CHIUDI</button>
                  {editing.quantity > 0 && (
                    <button onClick={()=>handleDrinkOne(editing)} style={{
                      background:"linear-gradient(135deg, #3a1a5a, #7a3a9a)",
                      color:"#f0d0ff", border:"none", borderRadius:8,
                      padding:"10px 18px", cursor:"pointer",
                      fontFamily:"'Cinzel', serif", fontSize:13, letterSpacing:1, fontWeight:700,
                      transition:"opacity 0.15s",
                    }}>🍷 BEVI UNA</button>
                  )}
                  <button className="btn-gold" onClick={()=>{setScanError(null);setModal("edit");}}>MODIFICA</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════ MODAL RACK ══════ */}
      {(rackModal==="add"||rackModal==="edit")&&editingRack&&(
        <div className="modal-overlay" onClick={()=>setRackModal(null)}>
          <div className="modal-box" style={{maxWidth:440}} onClick={e=>e.stopPropagation()}>
            <div style={{padding:"22px 26px 18px",borderBottom:`1px solid ${C.border}`}}>
              <h2 style={{fontFamily:"'Cinzel', serif",fontSize:17,color:C.gold,letterSpacing:2}}>{rackModal==="add"?"NUOVO SCAFFALE":"MODIFICA SCAFFALE"}</h2>
            </div>
            <div style={{padding:"22px 26px",display:"flex",flexDirection:"column",gap:16}}>
              <div>
                <label style={labelStyle}>Nome</label>
                <input style={inputStyle} value={editingRack.name} onChange={e=>setEditingRack(v=>({...v,name:e.target.value}))} placeholder="es. Scaffale Cantina Nord"/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                <div>
                  <label style={labelStyle}>File (A, B, C…)</label>
                  <input style={inputStyle} type="number" min="1" max="26" value={editingRack.rows} onChange={e=>setEditingRack(v=>({...v,rows:e.target.value}))}/>
                </div>
                <div>
                  <label style={labelStyle}>Colonne (1, 2, 3…)</label>
                  <input style={inputStyle} type="number" min="1" max="30" value={editingRack.cols} onChange={e=>setEditingRack(v=>({...v,cols:e.target.value}))}/>
                </div>
              </div>
              <div style={{background:C.bg,borderRadius:8,padding:"13px 15px"}}>
                <p style={{fontSize:15,color:C.textMuted,fontStyle:"italic",lineHeight:1.5}}>
                  Lo scaffale avrà <strong style={{color:C.gold}}>{(parseInt(editingRack.rows)||0)*(parseInt(editingRack.cols)||0)}</strong> posizioni,
                  da <strong style={{color:C.gold,fontFamily:"'Cinzel', serif"}}>{ROW_LABELS[0]}1</strong> a{" "}
                  <strong style={{color:C.gold,fontFamily:"'Cinzel', serif"}}>{ROW_LABELS[Math.max(0,(parseInt(editingRack.rows)||1)-1)]}{parseInt(editingRack.cols)||1}</strong>.
                </p>
              </div>
              <div style={{display:"flex",gap:12,justifyContent:"flex-end"}}>
                <button className="btn-ghost" onClick={()=>setRackModal(null)}>ANNULLA</button>
                <button className="btn-gold" onClick={handleSaveRack}>{rackModal==="add"?"CREA":"SALVA"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete wine */}
      {deleteConfirm&&(
        <div className="modal-overlay" onClick={()=>setDeleteConfirm(null)}>
          <div className="modal-box" style={{maxWidth:370}} onClick={e=>e.stopPropagation()}>
            <div style={{padding:"30px",textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:14}}>🗑</div>
              <h3 style={{fontFamily:"'Cinzel', serif",color:C.text,marginBottom:12,fontSize:16,letterSpacing:1}}>RIMUOVI VINO</h3>
              <p style={{color:C.textMuted,marginBottom:24,fontSize:16}}>Eliminare <strong style={{color:C.gold}}>{deleteConfirm.name}</strong>?</p>
              <div style={{display:"flex",gap:12,justifyContent:"center"}}>
                <button className="btn-ghost" onClick={()=>setDeleteConfirm(null)}>ANNULLA</button>
                <button className="btn-gold" style={{background:"linear-gradient(135deg, #7a2020, #c04040)"}}
                  onClick={()=>{saveWines(wines.filter(w=>w.id!==deleteConfirm.id));showToast(`"${deleteConfirm.name}" rimosso`);setDeleteConfirm(null);}}>ELIMINA</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete rack */}
      {deleteRackConfirm&&(
        <div className="modal-overlay" onClick={()=>setDeleteRackConfirm(null)}>
          <div className="modal-box" style={{maxWidth:400}} onClick={e=>e.stopPropagation()}>
            <div style={{padding:"30px",textAlign:"center"}}>
              <div style={{fontSize:36,marginBottom:14}}>🗄</div>
              <h3 style={{fontFamily:"'Cinzel', serif",color:C.text,marginBottom:12,fontSize:16,letterSpacing:1}}>ELIMINA SCAFFALE</h3>
              <p style={{color:C.textMuted,marginBottom:10,fontSize:16}}>Eliminare <strong style={{color:C.gold}}>{deleteRackConfirm.name}</strong>?</p>
              <p style={{color:"#c07070",marginBottom:24,fontSize:14,fontStyle:"italic"}}>Le posizioni dei vini assegnati verranno azzerate.</p>
              <div style={{display:"flex",gap:12,justifyContent:"center"}}>
                <button className="btn-ghost" onClick={()=>setDeleteRackConfirm(null)}>ANNULLA</button>
                <button className="btn-gold" style={{background:"linear-gradient(135deg, #7a2020, #c04040)"}} onClick={()=>handleDeleteRack(deleteRackConfirm)}>ELIMINA</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast&&(
        <div style={{position:"fixed",bottom:26,right:26,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"13px 20px",color:C.gold,fontFamily:"'Cinzel', serif",fontSize:14,letterSpacing:1,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",zIndex:300,animation:"fadeUp 0.2s ease"}}>
          {toast}
        </div>
      )}

      {/* Syncing overlay — mostrato solo al primo caricamento dal cloud */}
      {syncing&&(
        <div style={{position:"fixed",inset:0,background:"rgba(46,31,15,0.92)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:400,backdropFilter:"blur(6px)"}}>
          <div style={{width:48,height:48,border:"3px solid rgba(201,149,58,0.3)",borderTopColor:C.gold,borderRadius:"50%",animation:"spin 0.8s linear infinite",marginBottom:22}}/>
          <p style={{fontFamily:"'Cinzel', serif",color:C.gold,fontSize:16,letterSpacing:2}}>SINCRONIZZAZIONE…</p>
          <p style={{fontFamily:"'Cormorant Garamond', serif",color:C.textMuted,fontSize:14,marginTop:8,fontStyle:"italic"}}>Caricamento dati dalla cantina</p>
        </div>
      )}
    </div>
  );
}
