import { useState, useRef, useEffect } from "react";

const WINE_TYPES = ["Rosso", "Bianco", "Rosato", "Spumante", "Dolce", "Passito"];
const REGIONS = ["Piemonte", "Toscana", "Veneto", "Lombardia", "Sicilia", "Campania", "Sardegna", "Umbria", "Marche", "Puglia", "Altro"];
const ROW_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const STORAGE_KEY = "cantina-wines-v3";
const LOG_KEY = "cantina-log-v1";
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

// ── Auto-crop label from photo using pixel brightness analysis ──
// Trova la zona dell'etichetta cercando il rettangolo più "luminoso e uniforme"
function autoCropLabel(srcDataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = img.width, H = img.height;

      // Lavora su una versione ridotta per velocità
      const THUMB = 120;
      const tw = THUMB, th = Math.round(H / W * THUMB);
      const analysis = document.createElement("canvas");
      analysis.width = tw; analysis.height = th;
      const ctx = analysis.getContext("2d");
      ctx.drawImage(img, 0, 0, tw, th);
      const px = ctx.getImageData(0, 0, tw, th).data;

      // Calcola luminosità media per colonna e riga
      const rowBrightness = new Float32Array(th);
      const colBrightness = new Float32Array(tw);
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const i = (y * tw + x) * 4;
          const lum = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
          rowBrightness[y] += lum / tw;
          colBrightness[x] += lum / th;
        }
      }

      // Trova le righe/colonne con luminosità sopra la media (etichette sono più chiare della bottiglia)
      const avgLum = rowBrightness.reduce((a,b)=>a+b,0)/th;
      const threshold = avgLum * 0.92;

      let top = 0, bottom = th-1, left = 0, right = tw-1;

      // Trova bordi verticali: cerca dove la luminosità sale stabilmente
      for (let y = Math.floor(th*0.05); y < Math.floor(th*0.5); y++) {
        if (rowBrightness[y] > threshold) { top = Math.max(0, y-1); break; }
      }
      for (let y = th-1; y > Math.floor(th*0.5); y--) {
        if (rowBrightness[y] > threshold) { bottom = Math.min(th-1, y+1); break; }
      }
      // Bordi orizzontali
      for (let x = Math.floor(tw*0.05); x < Math.floor(tw*0.5); x++) {
        if (colBrightness[x] > threshold) { left = Math.max(0, x-1); break; }
      }
      for (let x = tw-1; x > Math.floor(tw*0.5); x--) {
        if (colBrightness[x] > threshold) { right = Math.min(tw-1, x+1); break; }
      }

      // Converti in coordinate originali con un po' di margine
      const margin = 0.02;
      const sx = Math.max(0,          Math.floor(W * (left/tw   - margin)));
      const sy = Math.max(0,          Math.floor(H * (top/th    - margin)));
      const ex = Math.min(W,          Math.ceil( W * (right/tw  + margin)));
      const ey = Math.min(H,          Math.ceil( H * (bottom/th + margin)));
      const sw = ex - sx, sh = ey - sy;

      // Se il ritaglio è troppo simile all'originale o troppo piccolo, restituisce null
      const cropRatio = (sw * sh) / (W * H);
      if (cropRatio > 0.92 || cropRatio < 0.05 || sw < 50 || sh < 50) {
        resolve(null); return;
      }

      // Esegui il ritaglio sull'immagine originale ad alta qualità
      const out = document.createElement("canvas");
      out.width = sw; out.height = sh;
      out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(out.toDataURL("image/jpeg", 0.93));
    };
    img.onerror = () => resolve(null);
    img.src = srcDataUrl;
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
        fontSize: readonly ? 22 : 30,
        color: s <= value ? "#c9953a" : "#b09878",
        transition: "color 0.15s", userSelect: "none",
      }}>★</span>
    ))}
  </div>
);

const TypeBadge = ({ type }) => {
  const c = typeColors[type] || { badge: "#555", text: "#eee" };
  return (
    <span style={{ background: c.badge, color: c.text, padding: "5px 15px", borderRadius: 20, fontSize: 15, fontFamily: "'Cinzel', serif", letterSpacing: 1, fontWeight: 700 }}>
      {type.toUpperCase()}
    </span>
  );
};

// ── Aging status calculator ──
const AGING_PROFILES = {
  "Bianco":   [{ max: 2, s: "Giovane", c: "#6aaa6a" }, { max: 5, s: "Apice", c: "#c9953a" }, { max: 8, s: "Maturo", c: "#b07030" }, { max: 999, s: "Declino", c: "#9a5050" }],
  "Rosato":   [{ max: 2, s: "Giovane", c: "#6aaa6a" }, { max: 4, s: "Apice", c: "#c9953a" }, { max: 6, s: "Maturo", c: "#b07030" }, { max: 999, s: "Declino", c: "#9a5050" }],
  "Spumante": [{ max: 3, s: "Giovane", c: "#6aaa6a" }, { max: 6, s: "Apice", c: "#c9953a" }, { max: 10, s: "Maturo", c: "#b07030" }, { max: 999, s: "Declino", c: "#9a5050" }],
  "Rosso":    [{ max: 3, s: "Giovane", c: "#6aaa6a" }, { max: 8, s: "Apice", c: "#c9953a" }, { max: 15, s: "Maturo", c: "#b07030" }, { max: 999, s: "Declino", c: "#9a5050" }],
  "Dolce":    [{ max: 3, s: "Giovane", c: "#6aaa6a" }, { max: 10, s: "Apice", c: "#c9953a" }, { max: 20, s: "Maturo", c: "#b07030" }, { max: 999, s: "Declino", c: "#9a5050" }],
  "Passito":  [{ max: 5, s: "Giovane", c: "#6aaa6a" }, { max: 15, s: "Apice", c: "#c9953a" }, { max: 25, s: "Maturo", c: "#b07030" }, { max: 999, s: "Declino", c: "#9a5050" }],
};
function getAgingStatus(wine) {
  if (!wine.year) return null;
  const age = new Date().getFullYear() - wine.year;
  const profile = AGING_PROFILES[wine.type] || AGING_PROFILES["Rosso"];
  return profile.find(p => age <= p.max) || profile[profile.length - 1];
}

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
  const [view,    setView]    = useState("catalog"); // "catalog" | "racks" | "stats"
  const [search,  setSearch]  = useState("");
  const [filterType, setFilterType] = useState("Tutti");
  const [filterAging, setFilterAging] = useState("Tutti");
  const [filtersOpen, setFiltersOpen] = useState(false);
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
  const [drinkModal, setDrinkModal] = useState(null);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [log, setLog] = useState(() => loadLocal(LOG_KEY, []));
  const [logModal, setLogModal] = useState(null); // wine being logged
  const [logEntry, setLogEntry] = useState(null); // current entry being edited
  const [logView, setLogView] = useState("list"); // "list" | "entry"
  const [viewingEntry, setViewingEntry] = useState(null); // wine to drink from
  const [enriching, setEnriching] = useState(false);
  const [enrichData, setEnrichData] = useState(null);
  const [enrichError, setEnrichError] = useState(null);
  const scanInputRef = useRef(null);
  const nextWineId = useRef(Math.max(...wines.map(w => w.id), 99) + 1);
  const nextRackId = useRef(Math.max(...racks.map(r => r.id), 99) + 1);

  // Carica dal cloud al primo avvio, poi ri-analizza i vini con analisi scaduta (>6 mesi)
  useEffect(() => {
    if (!IS_NETLIFY) return;
    cloudLoad().then(data => {
      let loadedWines = null;
      if (data) {
        if (data.wines) { loadedWines = migrateWines(data.wines); setWines(loadedWines); saveLocal(STORAGE_KEY, loadedWines); }
        if (data.racks) { setRacks(data.racks); saveLocal(RACKS_KEY, data.racks); }
        if (data.log)   { setLog(data.log);    saveLocal(LOG_KEY, data.log); }
      }
      setSyncing(false);
      // Ri-analizza i vini con analisi scaduta (>6 mesi)
      if (loadedWines) {
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
        const stale = loadedWines.filter(w =>
          w.enrichment?.enrichedAt && new Date(w.enrichment.enrichedAt) < sixMonthsAgo
        );
        if (stale.length > 0) {
          showToast(`🔄 Aggiornamento analisi per ${stale.length} vino/i…`);
          stale.forEach((wine, i) => {
            setTimeout(() => autoEnrich(wine, loadedWines), i * 3000); // 3s di gap tra una e l'altra
          });
        }
      }
    });
  }, []);

  const saveWines = (w) => { setWines(w); saveLocal(STORAGE_KEY, w); cloudSave({ wines: w }); };
  const saveRacks = (r) => { setRacks(r); saveLocal(RACKS_KEY,  r); cloudSave({ racks: r }); };
  const saveLog   = (l) => { setLog(l);   saveLocal(LOG_KEY,   l); cloudSave({ log:   l }); };
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const filtered = wines
    .filter(w => filterType === "Tutti" || w.type === filterType)
    .filter(w => filterAging === "Tutti" || getAgingStatus(w)?.s === filterAging)
    .filter(w => {
      const q = search.toLowerCase();
      // Costruisce array di tutti i campi testuali ricercabili
      const fields = [
        w.name || "",
        w.producer || "",
        w.region || "",
        w.grape || "",
        w.type || "",
        w.notes || "",
        w.year ? String(w.year) : "",
        w.price ? String(w.price) : "",
        ...(Array.isArray(w.positions) ? w.positions : []),
      ];
      if (w.enrichment && typeof w.enrichment === "object") {
        ["grapeProfile","tastingNotes","territory","foodPairing","aging","curiosity"].forEach(k => {
          if (typeof w.enrichment[k] === "string") fields.push(w.enrichment[k]);
        });
      }
      return !q || fields.some(f => f.toLowerCase().includes(q));
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
      // Ridimensiona aggressivamente: max 350px, qualità 55%
      // Il corpo della richiesta deve stare sotto i 4MB di Netlify
      // Per la scansione API: immagine piccola (velocità)
      const scanDataUrl = await resizeImage(file, 700, 0.82);
      // Thumbnail ad alta qualità sull'originale
      const hiResDataUrl = await resizeImage(file, 1800, 0.93);

      const info = await scanLabel(scanDataUrl);

      // Ritaglia l'etichetta usando le coordinate restituite dall'API
      // Ritaglia automaticamente l'etichetta analizzando i pixel
      const croppedThumb = await autoCropLabel(hiResDataUrl);
      console.log("Auto-crop:", croppedThumb ? "ritagliato" : "fallback all'intera foto");
      const thumb = croppedThumb || hiResDataUrl;

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
      showToast(croppedThumb ? "✨ Etichetta riconosciuta e ritagliata!" : "✨ Etichetta riconosciuta!");
    } catch (err) {
      console.error(err);
      setScanError("Non sono riuscito a leggere l'etichetta. Riprova con una foto più nitida.");
    } finally {
      setScanning(false);
    }
  };

  // Bevi una bottiglia: apre il selettore di posizione se ne ha, altrimenti decrementa
  const handleDrinkOne = (wine) => {
    if ((wine.positions || []).length > 0) {
      setDrinkModal(wine); // apri selettore posizione
    } else {
      commitDrink(wine, null);
    }
  };

  // Conferma la bevuta: aggiorna cantina e apre il form dello storico
  const commitDrink = (wine, posToRemove) => {
    const newQty = wine.quantity - 1;
    const positions = wine.positions || [];
    const newPositions = posToRemove
      ? positions.filter(p => p !== posToRemove)
      : positions.slice(0, -1);

    // Aggiorna la cantina
    const shouldDelete = newQty <= 0;
    if (!shouldDelete) {
      const updated = { ...wine, quantity: newQty, positions: newPositions };
      saveWines(wines.map(w => w.id === wine.id ? updated : w));
      setEditing(updated);
    } else {
      saveWines(wines.filter(w => w.id !== wine.id));
      setEditing(null);
      setModal(null);
    }
    setDrinkModal(null);

    // Apri il form per registrare la bevuta nello storico
    setLogEntry({
      id: Date.now(),
      wineId: wine.id,
      wineName: wine.name,
      wineProducer: wine.producer,
      wineYear: wine.year,
      wineType: wine.type,
      wineGrape: wine.grape,
      wineRegion: wine.region,
      winePhoto: wine.photo || null,
      date: new Date().toISOString().split("T")[0],
      occasion: "",
      companions: "",
      rating: 4,
      notes: "",
      finished: true,
    });
    setLogModal("add");
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
      const enrichment = { ...data, enrichedAt: new Date().toISOString() };
      setEnrichData(enrichment);
      // Salva automaticamente l'analisi nella bottiglia
      const updated = { ...wine, enrichment };
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
      const wine = { ...editing, id: nextWineId.current++ };
      const newList = [...wines, wine];
      saveWines(newList);
      setModal(null);
      showToast(`"${wine.name}" aggiunto — analisi in corso…`);
      setTimeout(() => autoEnrich(wine, newList), 500);
    } else {
      saveWines(wines.map(w => w.id === editing.id ? editing : w));
      showToast(`"${editing.name}" aggiornato`);
      setModal(null);
    }
  };

  // Analisi automatica in background senza bloccare la UI
  const autoEnrich = async (wine, baseList) => {
    try {
      const resp = await fetch("/.netlify/functions/enrich-wine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wine.name, producer: wine.producer, year: wine.year,
          type: wine.type, region: wine.region, grape: wine.grape,
        }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const enrichment = { ...data, enrichedAt: new Date().toISOString() };
      const updated = { ...wine, enrichment };
      saveWines(baseList.map(w => w.id === wine.id ? updated : w));
      showToast(`✨ Analisi di "${wine.name}" completata`);
    } catch { /* silenzioso */ }
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
    fontFamily: "'EB Garamond', serif", fontSize: 20, outline: "none",
    transition: "border-color 0.15s",
  };
  const labelStyle = {
    color: C.textFaint, fontSize: 15, letterSpacing: 1.2,
    fontFamily: "'Cinzel', serif", textTransform: "uppercase", marginBottom: 6, display: "block",
  };

  const MiniRackMap = ({ rack, highlightPositions }) => (
    <div style={{ overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 3, marginBottom: 3, marginLeft: 28 }}>
        {Array.from({ length: rack.cols }, (_, c) => (
          <div key={c} style={{ width: 40, textAlign: "center", fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{c + 1}</div>
        ))}
      </div>
      {Array.from({ length: rack.rows }, (_, r) => (
        <div key={r} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
          <div style={{ width: 26, textAlign: "center", fontSize: 15, color: C.textFaint, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>{ROW_LABELS[r]}</div>
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
            <div key={c} style={{ width: 40, textAlign: "center", fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{c + 1}</div>
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
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'EB Garamond', serif", color: C.text, fontSize: 20, overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow-x: hidden; max-width: 100vw; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input, select, textarea { color-scheme: dark; }
        input::placeholder, textarea::placeholder { color: ${C.textFaint}; }
        select option { background: ${C.surface}; color: ${C.text}; }
        input:focus, select:focus, textarea:focus { border-color: ${C.gold} !important; box-shadow: 0 0 0 2px rgba(201,149,58,0.14); }
        .wine-card { transition: transform 0.18s, box-shadow 0.18s; }
        .wine-card:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(0,0,0,0.4) !important; }
        .btn-gold { background: linear-gradient(135deg, #a07828, ${C.gold}, #a07828); color: #1a0800; border: none; border-radius: 8px; padding: 12px 24px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 16px; letter-spacing: 1.5px; font-weight: 700; transition: opacity 0.15s, transform 0.12s; white-space: nowrap; }
        .btn-gold:hover { opacity: 0.88; transform: translateY(-1px); }
        .btn-ghost { background: transparent; color: ${C.textMuted}; border: 1px solid ${C.border}; border-radius: 8px; padding: 11px 22px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 16px; letter-spacing: 1px; transition: border-color 0.15s, color 0.15s; white-space: nowrap; }
        .btn-ghost:hover { border-color: ${C.gold}; color: ${C.gold}; }
        .btn-sm { background: ${C.surface2}; color: ${C.textMuted}; border: 1px solid ${C.border}; border-radius: 7px; padding: 8px 16px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: all 0.15s; }
        .btn-sm:hover { color: ${C.gold}; border-color: ${C.gold}; }
        .btn-danger { background: transparent; color: #c07070; border: 1px solid #804040; border-radius: 8px; padding: 10px 16px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: background 0.15s; }
        .btn-danger:hover { background: rgba(180,60,60,0.15); }
        .tab-btn { background: none; border: 1px solid transparent; cursor: pointer; padding: 8px 16px; border-radius: 20px; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: all 0.15s; }
        .nav-btn { background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; padding: 12px 22px; font-family: 'Cinzel', serif; font-size: 16px; letter-spacing: 2px; transition: all 0.15s; color: ${C.textFaint}; }
        .nav-btn.active { color: ${C.gold}; border-bottom-color: ${C.gold}; }
        .nav-btn:hover:not(.active) { color: ${C.textMuted}; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; z-index: 200; padding: 8px; backdrop-filter: blur(4px); }
        .modal-box { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; width: 100%; max-width: min(98vw, 1100px); max-height: 96vh; overflow-y: auto; box-shadow: 0 30px 80px rgba(0,0,0,0.6); animation: fadeUp 0.22s ease; }
        @keyframes fadeUp { from { opacity:0; transform: translateY(18px) scale(0.97); } to { opacity:1; transform: none; } }

        @media (max-width: 600px) {
          /* Compact cards on mobile */
          .wine-card { font-size: 15px !important; }
          .wine-card h3 { font-size: 17px !important; }
          .wine-card p  { font-size: 14px !important; }

          /* Compact filter tabs */
          .tab-btn { padding: 5px 10px !important; font-size: 12px !important; }
          .nav-btn  { padding: 9px 14px !important; font-size: 13px !important; }

          /* Modal almost full screen */
          .modal-overlay { padding: 4px !important; align-items: flex-end !important; }
          .modal-box { border-radius: 16px 16px 0 0 !important; max-height: 97vh !important; }

          /* Smaller header on mobile */
          .mobile-header-title { font-size: 18px !important; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .rack-card { background: ${C.surface2}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .action-btn { flex: 1; background: none; border: none; cursor: pointer; padding: 10px; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: color 0.15s, background 0.15s; }

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
      <header style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "16px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 34 }}>🍷</span>
          <div>
            <h1 className="mobile-header-title" style={{ fontFamily: "'Cinzel', serif", fontSize: 26, fontWeight: 700, color: C.gold, letterSpacing: 3 }}>CANTINA VETTORELLO</h1>
          </div>
        </div>
        <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
          {[["BOTTIGLIE", totalBottles], ["ETICHETTE", wines.length], ["SCAFFALI", racks.length]].map(([l, v]) => (
            <div key={l} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 30, fontWeight: 300, color: C.gold }}>{v}</div>
              <div style={{ fontSize: 15, color: C.textFaint, letterSpacing: 1.5, fontFamily: "'Cinzel', serif" }}>{l}</div>
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
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 8px", display: "flex", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        {[["catalog","📋  CATALOGO"],["racks","🗄  SCAFFALI"],["stats","📊  STATISTICHE"],["logview","📖  STORICO"]].map(([v,l]) => (
          <button key={v} className={`nav-btn ${view===v?"active":""}`} onClick={() => setView(v)}>{l}</button>
        ))}
      </div>

      {/* ══════ CATALOG VIEW ══════ */}
      {view === "catalog" && <>
        <div style={{ padding: "10px 16px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          {/* Barra ricerca + toggle filtri */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, position: "relative" }}>
              <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: C.textFaint, fontSize: 16 }}>🔍</span>
              <input placeholder="Cerca in tutti i campi…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ ...inputStyle, paddingLeft: 40, paddingRight: search ? 38 : 14 }} />
              {search && (
                <button onClick={() => setSearch("")} style={{
                  position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                  background: C.border, border: "none", borderRadius: "50%",
                  width: 22, height: 22, cursor: "pointer", color: C.text,
                  fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center",
                }}>✕</button>
              )}
            </div>
            {/* Indicatori filtri attivi */}
            {(filterType !== "Tutti" || filterAging !== "Tutti") && (
              <span style={{ fontSize: 12, color: C.gold, fontFamily: "'Cinzel', serif", whiteSpace: "nowrap" }}>
                {[filterType !== "Tutti" ? filterType : null, filterAging !== "Tutti" ? filterAging : null].filter(Boolean).join(" · ")}
              </span>
            )}
            {/* Toggle filtri */}
            <button onClick={() => setFiltersOpen(o => !o)} style={{
              background: filtersOpen ? "rgba(201,149,58,0.14)" : C.surface2,
              border: `1px solid ${filtersOpen ? "rgba(201,149,58,0.4)" : C.border}`,
              borderRadius: 8, padding: "8px 13px", cursor: "pointer",
              color: filtersOpen ? C.gold : C.textFaint,
              fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1,
              display: "flex", alignItems: "center", gap: 5, transition: "all 0.15s",
              whiteSpace: "nowrap",
            }}>
              FILTRI {filtersOpen ? "▲" : "▼"}
            </button>
          </div>

          {/* Filtri espandibili */}
          {filtersOpen && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {/* Tipo */}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, minWidth: 38 }}>TIPO</span>
                {["Tutti",...WINE_TYPES].map(t => (
                  <button key={t} className="tab-btn" onClick={() => setFilterType(t)} style={{ color: filterType===t?C.gold:C.textFaint, background: filterType===t?"rgba(201,149,58,0.14)":"none", border: filterType===t?`1px solid rgba(201,149,58,0.4)`:"1px solid transparent" }}>{t.toUpperCase()}</button>
                ))}
              </div>
              {/* Stato */}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, minWidth: 38 }}>STATO</span>
                {[
                  { key: "Tutti", label: "Tutti", icon: "" },
                  { key: "Giovane", label: "Giovane", icon: "🌱" },
                  { key: "Apice", label: "Apice", icon: "⭐" },
                  { key: "Maturo", label: "Maturo", icon: "🍂" },
                  { key: "Declino", label: "Declino", icon: "📉" },
                ].map(({ key, label, icon }) => (
                  <button key={key} className="tab-btn" onClick={() => setFilterAging(key)} style={{
                    color: filterAging===key?C.gold:C.textFaint,
                    background: filterAging===key?"rgba(201,149,58,0.14)":"none",
                    border: filterAging===key?`1px solid rgba(201,149,58,0.4)`:"1px solid transparent",
                  }}>{icon} {label.toUpperCase()}</button>
                ))}
              </div>
              {/* Ordina */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, minWidth: 38 }}>ORDINA</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inputStyle, width: "auto", fontSize: 14, padding: "7px 10px" }}>
                  <option value="name">Nome</option>
                  <option value="year">Annata</option>
                  <option value="rating">Valutazione</option>
                  <option value="quantity">Quantità</option>
                </select>
                {sortBy === "year" && (
                  <button onClick={() => setSortDir(d => d==="asc"?"desc":"asc")} style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, color: C.gold, cursor: "pointer", padding: "7px 12px", fontFamily: "'Cinzel', serif", fontSize: 13 }}>
                    {sortDir==="asc" ? "↑ Più vecchi" : "↓ Più recenti"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: "20px 16px" }}>
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.4 }}>🍷</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 15 }}>{wines.length===0?"LA CANTINA È VUOTA":"NESSUN RISULTATO"}</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 18 }}>
              {filtered.map(wine => {
                const tc = typeColors[wine.type] || { bar: "#888" };
                const rack = racks.find(r => r.id === wine.rackId);
                return (
                  <div key={wine.id} className="wine-card" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", boxShadow: "0 3px 12px rgba(0,0,0,0.25)" }}
                    onClick={() => { setEditing({...wine}); setEnrichData(null); setEnrichError(null); setModal("view"); }}>
                    <div style={{ height: 3, background: `linear-gradient(90deg, ${tc.bar}, ${C.gold})` }} />

                    <div style={{ padding: "11px 14px 10px", display: "flex", gap: 12 }}>
                      {/* Thumbnail compatto */}
                      {wine.photo && (
                        <div onClick={e => { e.stopPropagation(); setLightboxPhoto(wine.photo); }}
                          style={{ flexShrink: 0, width: 54, alignSelf: "flex-start", cursor: "zoom-in", borderRadius: 6, overflow: "hidden", border: `1px solid ${C.border}`, marginTop: 2 }}>
                          <img src={wine.photo} alt={wine.name} style={{ width: "100%", display: "block", objectFit: "cover", aspectRatio: "2/3" }} />
                        </div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Riga 1: badge tipo + anno + quantità */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <TypeBadge type={wine.type} />
                          <span style={{ fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1 }}>{wine.year}</span>
                        </div>
                        <span style={{ background: wine.quantity===0?"rgba(180,60,60,0.2)":wine.quantity<=2?"rgba(180,150,60,0.2)":"rgba(60,150,60,0.2)", color: wine.quantity===0?"#d07070":wine.quantity<=2?"#c0b040":"#70c070", padding: "3px 10px", borderRadius: 20, fontSize: 14, fontFamily: "'Cinzel', serif", fontWeight: 600 }}>{wine.quantity} bt</span>
                      </div>

                      {/* Riga 2: nome */}
                      <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, fontWeight: 600, color: C.text, marginBottom: 2, lineHeight: 1.25 }}>{wine.name}</h3>

                      {/* Riga 3: produttore + stelle inline */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic", margin: 0 }}>{wine.producer}</p>
                        <StarRating value={wine.rating} readonly />
                      </div>

                      {/* Riga 4: regione + vitigno + posizione + prezzo */}
                      <div style={{ display: "flex", gap: 8, fontSize: 13, color: C.textFaint, flexWrap: "wrap", alignItems: "center" }}>
                        {wine.region && <span>📍 {wine.region}</span>}
                        {wine.grape  && <span>🍇 {wine.grape}</span>}
                        {rack && (wine.positions||[]).length > 0 && (
                          <span style={{ color: C.gold, fontFamily: "'Cinzel', serif", fontWeight: 700, fontSize: 13 }}>
                            🗄 {rack.name} · {(wine.positions||[]).join(", ")}
                          </span>
                        )}
                        {wine.price && <span style={{ marginLeft: "auto", color: C.textFaint }}>€{wine.price}</span>}
                      </div>

                      {/* Riga 5: stato invecchiamento — solo badge */}
                      {(()=>{ const ag = getAgingStatus(wine); if (!ag) return null;
                        const age = new Date().getFullYear() - wine.year;
                        return (
                          <div style={{ marginTop: 6, display: "inline-flex", alignItems: "center", gap: 6, background: `${ag.c}18`, border: `1px solid ${ag.c}44`, borderRadius: 20, padding: "3px 10px" }}>
                            <span style={{ fontSize: 12, color: ag.c, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>
                              {ag.s==="Giovane"?"🌱":ag.s==="Apice"?"⭐":ag.s==="Maturo"?"🍂":"📉"} {ag.s.toUpperCase()}
                            </span>
                            <span style={{ fontSize: 11, color: C.textFaint }}>{age} {age===1?"anno":"anni"}</span>
                          </div>
                        );
                      })()}
                    </div>
                    </div>
                    <div style={{ borderTop: `1px solid ${C.bg}`, display: "flex" }}>
                      {[["✏ MODIFICA", () => { setEditing({...wine}); setScanError(null); setModal("edit"); }, false],
                        ["✕ ELIMINA",  () => setDeleteConfirm(wine), true]].map(([label,fn,danger]) => (
                        <button key={label} className="action-btn" style={{ color: danger?"#9a5050":C.textFaint, borderRight: !danger?`1px solid ${C.bg}`:"none", padding: "7px" }}
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
        <div style={{ padding: "20px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
            <div>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.gold, letterSpacing: 2, marginBottom: 8 }}>I MIEI SCAFFALI</h2>
              <p style={{ fontSize: 17, color: C.textMuted, fontStyle: "italic" }}>Ogni cella è una posizione A1, B3… Clicca su una bottiglia per i dettagli.</p>
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
                      <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.text, letterSpacing: 1 }}>{rack.name}</h3>
                      <p style={{ fontSize: 16, color: C.textFaint, marginTop: 5 }}>{rack.rows} file ({ROW_LABELS[0]}–{ROW_LABELS[rack.rows-1]}) × {rack.cols} colonne · {occ.length}/{rack.rows*rack.cols} occupate</p>
                    </div>
                    <div style={{ display: "flex", gap: 9 }}>
                      <button className="btn-sm" onClick={() => { setEditingRack({...rack}); setRackModal("edit"); }}>✏ Modifica</button>
                      <button className="btn-danger" onClick={() => setDeleteRackConfirm(rack)}>✕</button>
                    </div>
                  </div>
                  <div style={{ padding: "20px 22px", overflowX: "auto" }}>
                    <div style={{ display: "flex", gap: 4, marginBottom: 4, marginLeft: 32 }}>
                      {Array.from({length:rack.cols},(_,c)=>(
                        <div key={c} style={{ width:56, textAlign:"center", fontSize:15, color:C.textFaint, fontFamily:"'Cinzel', serif", fontWeight:600 }}>{c+1}</div>
                      ))}
                    </div>
                    {Array.from({length:rack.rows},(_,r)=>(
                      <div key={r} style={{ display:"flex", alignItems:"center", gap:4, marginBottom:4 }}>
                        <div style={{ width:28, textAlign:"center", fontSize:16, color:C.textFaint, fontFamily:"'Cinzel', serif", fontWeight:700 }}>{ROW_LABELS[r]}</div>
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
                        <span style={{fontSize:15,color:C.textFaint,fontFamily:"'Cinzel', serif",letterSpacing:1}}>LEGENDA:</span>
                        {[...new Set(occ.map(w=>w.type))].map(type=>{const c=typeColors[type];return(
                          <div key={type} style={{display:"flex",alignItems:"center",gap:6}}>
                            <div style={{width:14,height:14,background:c.badge,border:`1px solid ${c.bar}`,borderRadius:3}}/>
                            <span style={{fontSize:15,color:C.textFaint,fontFamily:"'Cinzel', serif"}}>{type}</span>
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

      {/* ══════ STATS VIEW ══════ */}
      {view === "stats" && (() => {
        const totalBt = wines.reduce((s,w) => s+w.quantity, 0);
        const byType  = {}, byGrape = {}, byRegion = {};
        wines.forEach(w => {
          const q = w.quantity || 1;
          byType[w.type]     = (byType[w.type]     || 0) + q;
          if (w.grape)  byGrape[w.grape]   = (byGrape[w.grape]   || 0) + q;
          if (w.region) byRegion[w.region] = (byRegion[w.region] || 0) + q;
        });
        const mkRows = (obj) => Object.entries(obj).sort(([,a],[,b])=>b-a).map(([k,v])=>({ label:k, count:v, pct: totalBt>0?Math.round(v/totalBt*100):0 }));
        const Bar = ({ pct, color }) => (
          <div style={{ flex:1, height:8, background:`${color}22`, borderRadius:4, overflow:"hidden" }}>
            <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:4, transition:"width 0.6s ease" }}/>
          </div>
        );
        const Section = ({ title, rows, color }) => (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>
            <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}`, fontFamily:"'Cinzel', serif", fontSize:15, color:C.gold, letterSpacing:2 }}>{title}</div>
            <div style={{ padding:"12px 20px", display:"flex", flexDirection:"column", gap:10 }}>
              {rows.map(r => (
                <div key={r.label}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                    <span style={{ fontSize:16, color:C.text, fontFamily:"'EB Garamond', serif" }}>{r.label}</span>
                    <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                      <span style={{ fontSize:14, color:C.textFaint }}>{r.count} bt</span>
                      <span style={{ fontSize:15, color:color, fontFamily:"'Cinzel', serif", fontWeight:700, minWidth:38, textAlign:"right" }}>{r.pct}%</span>
                    </div>
                  </div>
                  <Bar pct={r.pct} color={color}/>
                </div>
              ))}
            </div>
          </div>
        );
        return (
          <div style={{ padding:"28px 32px", display:"flex", flexDirection:"column", gap:20 }}>
            <h2 style={{ fontFamily:"'Cinzel', serif", fontSize:18, color:C.gold, letterSpacing:2 }}>COMPOSIZIONE DELLA CANTINA</h2>
            {/* Riepilogo */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(140px,1fr))", gap:12 }}>
              {[["🍷","Bottiglie totali",totalBt],["🏷","Etichette",wines.length],["🗄","Scaffali",racks.length],
                ["💰","Valore stimato",`€${wines.reduce((s,w)=>s+w.quantity*(parseFloat(w.price)||0),0).toFixed(0)}`]
              ].map(([icon,label,val])=>(
                <div key={label} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", textAlign:"center" }}>
                  <div style={{ fontSize:24, marginBottom:4 }}>{icon}</div>
                  <div style={{ fontSize:22, fontWeight:300, color:C.gold, fontFamily:"'Cinzel', serif" }}>{val}</div>
                  <div style={{ fontSize:12, color:C.textFaint, fontFamily:"'Cinzel', serif", letterSpacing:1, marginTop:3 }}>{label.toUpperCase()}</div>
                </div>
              ))}
            </div>
            <Section title="PER TIPOLOGIA" rows={mkRows(byType)} color={C.gold}/>
            <Section title="PER VITIGNO"   rows={mkRows(byGrape)} color="#7a9aba"/>
            <Section title="PER REGIONE"   rows={mkRows(byRegion)} color="#8aba7a"/>
          </div>
        );
      })()}

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

              {/* X close button — sticky, always visible while scrolling */}
              <div style={{position:"sticky",top:0,zIndex:10,display:"flex",justifyContent:"flex-end",pointerEvents:"none"}}>
                <button onClick={()=>{setModal(null);setEnrichData(null);setEnrichError(null);}}
                  style={{
                    pointerEvents:"all",
                    margin:"12px 14px 0 0",
                    background:"rgba(30,15,5,0.75)", border:`1px solid ${C.border}`,
                    borderRadius:"50%", width:42, height:42, cursor:"pointer",
                    color:C.textMuted, fontSize:18, lineHeight:1,
                    display:"flex", alignItems:"center", justifyContent:"center",
                    backdropFilter:"blur(6px)", transition:"background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={e=>{e.currentTarget.style.background="rgba(60,30,10,0.95)";e.currentTarget.style.color=C.gold;}}
                  onMouseLeave={e=>{e.currentTarget.style.background="rgba(30,15,5,0.75)";e.currentTarget.style.color=C.textMuted;}}
                >✕</button>
              </div>

              {/* Photo hero — tappabile per lightbox */}
              {editing.photo && (
                <div onClick={() => setLightboxPhoto(editing.photo)}
                  style={{height:180,overflow:"hidden",position:"relative",display:"flex",alignItems:"center",justifyContent:"center",background:"#1a0f08",cursor:"zoom-in"}}>
                  <img src={editing.photo} alt={editing.name} style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain"}}/>
                  <div style={{position:"absolute",inset:0,background:"linear-gradient(to bottom, transparent 40%, rgba(62,42,22,0.9) 100%)"}}/>
                  <div style={{position:"absolute",bottom:12,left:22,right:22,display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
                    <TypeBadge type={editing.type}/>
                    <span style={{fontSize:11,color:"rgba(255,255,255,0.5)",fontFamily:"'Cinzel', serif",letterSpacing:1}}>🔍 tocca per ingrandire</span>
                  </div>
                  <div style={{position:"absolute",top:14,right:18,fontSize:26,fontWeight:300,color:C.gold,fontFamily:"'Cinzel', serif"}}>{editing.year}</div>
                </div>
              )}

              <div style={{padding:"16px 20px"}}>
                {!editing.photo && (
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                    <TypeBadge type={editing.type}/>
                    <span style={{fontSize:30,fontWeight:300,color:C.gold,fontFamily:"'Cinzel', serif"}}>{editing.year}</span>
                  </div>
                )}
                <h2 style={{fontFamily:"'Cinzel', serif",fontSize:22,color:C.text,marginBottom:3,marginTop:editing.photo?6:0}}>{editing.name}</h2>
                <p style={{fontSize:16,color:C.textMuted,fontStyle:"italic",marginBottom:10}}>{editing.producer}</p>

                {/* Info compatte: riga orizzontale di pill */}
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:12}}>
                  {[
                    ["📍", editing.region],
                    ["🍇", editing.grape||null],
                    ["🍾", `${editing.quantity} bt`],
                    ...(editing.price?[["💰", `€${editing.price}`]]:[]),
                    ...(rack?[["🗄", rack.name]]:[]),
                  ].filter(([,v])=>v).map(([icon,val])=>(
                    <span key={icon+val} style={{
                      display:"inline-flex", alignItems:"center", gap:4,
                      background:C.bg, border:`1px solid ${C.border}`,
                      borderRadius:20, padding:"5px 12px",
                      fontSize:15, color:C.text,
                    }}>
                      <span>{icon}</span>
                      <span style={{fontFamily:"'EB Garamond', serif"}}>{val}</span>
                    </span>
                  ))}
                  {/* Posizioni evidenziate */}
                  {(editing.positions||[]).length > 0 && rack && (
                    <span style={{
                      display:"inline-flex", alignItems:"center", gap:4,
                      background:"rgba(201,149,58,0.12)", border:`1px solid rgba(201,149,58,0.35)`,
                      borderRadius:20, padding:"5px 14px",
                      fontSize:15, color:C.gold, fontFamily:"'Cinzel', serif", fontWeight:700,
                    }}>
                      📌 {(editing.positions||[]).join(" · ")}
                    </span>
                  )}
                </div>

                {/* ── Stato del Vino ── */}
                {(()=>{
                  const ag = getAgingStatus(editing);
                  if (!ag) return null;
                  const age = new Date().getFullYear() - editing.year;
                  const agingNote = editing.enrichment?.aging || null;
                  return (
                    <div style={{background:C.bg, border:`1px solid ${ag.c}44`, borderRadius:10, padding:"14px 16px", marginBottom:14}}>
                      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: agingNote ? 10 : 0}}>
                        <div style={{display:"flex", alignItems:"center", gap:10}}>
                          <span style={{fontSize:28}}>
                            {ag.s==="Giovane"?"🌱":ag.s==="Apice"?"⭐":ag.s==="Maturo"?"🍂":"📉"}
                          </span>
                          <div>
                            <div style={{fontSize:16, color:ag.c, fontFamily:"'Cinzel', serif", fontWeight:700, letterSpacing:1}}>{ag.s.toUpperCase()}</div>
                            <div style={{fontSize:14, color:C.textFaint}}>{age} {age===1?"anno":"anni"} · {editing.type}</div>
                          </div>
                        </div>
                        {/* Barra visiva invecchiamento */}
                        {(()=>{
                          const profile = [
                            {label:"Giovane", c:"#6aaa6a"},
                            {label:"Apice",   c:"#c9953a"},
                            {label:"Maturo",  c:"#b07030"},
                            {label:"Declino", c:"#9a5050"},
                          ];
                          return (
                            <div style={{display:"flex", gap:3}}>
                              {profile.map(p => (
                                <div key={p.label} title={p.label} style={{
                                  width:10, height:10, borderRadius:"50%",
                                  background: p.label===ag.s ? p.c : `${p.c}33`,
                                  border: `1px solid ${p.c}88`,
                                }}/>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                      {agingNote && (
                        <p style={{fontSize:17, color:C.textMuted, fontFamily:"'EB Garamond', serif", lineHeight:1.7, margin:0}}>
                          {agingNote}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {rack&&(editing.positions||[]).length>0&&(
                  <div style={{background:C.bg,borderRadius:9,padding:"10px 12px",marginBottom:10,border:`1px solid ${C.border}`}}>
                    <div style={{fontSize:12,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:8}}>POSIZIONE — {rack.name}</div>
                    <MiniRackMap rack={rack} highlightPositions={editing.positions||[]}/>
                  </div>
                )}

                <div style={{marginBottom:10,display:"flex",alignItems:"center",gap:14}}>
                  <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif"}}>VALUTAZIONE</div>
                  <StarRating value={editing.rating} readonly/>
                </div>
                {editing.notes&&(
                  <div style={{background:C.bg,borderRadius:8,padding:"10px 14px",marginBottom:10}}>
                    <div style={{fontSize:12,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:4}}>NOTE DI DEGUSTAZIONE</div>
                    <p style={{fontSize:17,color:C.textMuted,lineHeight:1.7,fontFamily:"'EB Garamond', serif"}}>{editing.notes}</p>
                  </div>
                )}
                {/* ── APPROFONDISCI ── */}
                {(()=>{
                  // Mostra i dati salvati nella bottiglia, o quelli appena scaricati
                  const displayData = enrichData || editing.enrichment || null;
                  return (
                    <div style={{background:C.bg,borderRadius:9,padding:"10px 14px",marginBottom:10,border:`1px solid ${C.border}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom: displayData||enriching||enrichError ? 12 : 0}}>
                        <div>
                          <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif"}}>
                            🔍 ANALISI DEL VINO
                          </div>
                          {editing.enrichment && !enriching && (
                            <div style={{fontSize:12,color:C.textFaint,marginTop:3,fontStyle:"italic"}}>
                              {editing.enrichment.enrichedAt
                                ? `Analisi del ${new Date(editing.enrichment.enrichedAt).toLocaleDateString("it-IT",{day:"2-digit",month:"long",year:"numeric"})} · clicca per aggiornare`
                                : "Analisi salvata · clicca per aggiornare"}
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
                        <div style={{display:"flex",flexDirection:"column",gap:10}}>
                          {[
                            ["🍇 Il Vitigno", displayData.grapeProfile],
                            ["👃 Sentori & Degustazione", displayData.tastingNotes],
                            ["🌍 Territorio & Denominazione", displayData.territory],
                            ["⏳ Invecchiamento", displayData.aging],
                            ["🍽 Abbinamenti Gastronomici", displayData.foodPairing],
                            ["💡 Lo sapevi?", displayData.curiosity],
                          ].filter(([,v]) => v).map(([label, text]) => (
                            <div key={label} style={{paddingLeft:0}}>
                              <div style={{fontSize:13,color:C.gold,fontFamily:"'Cinzel', serif",letterSpacing:1,marginBottom:3,fontWeight:700}}>
                                {label}
                              </div>
                              <p style={{fontSize:17,color:C.textMuted,lineHeight:1.7,fontFamily:"'EB Garamond', serif",margin:0}}>
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

                <div style={{display:"flex",gap:6,alignItems:"center",justifyContent:"stretch"}}>
                  {/* ELIMINA — icona */}
                  <button onClick={()=>{setModal(null);setDeleteConfirm(editing);}} title="Elimina"
                    style={{flex:"0 0 auto",background:"transparent",border:`1px solid #804040`,borderRadius:8,
                      color:"#c07070",cursor:"pointer",padding:"11px 13px",fontSize:18,lineHeight:1,
                      transition:"background 0.15s",}}
                    onMouseEnter={e=>e.currentTarget.style.background="rgba(180,60,60,0.15)"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                  >🗑</button>
                  {/* BEVI */}
                  {editing.quantity > 0 && (
                    <button onClick={()=>handleDrinkOne(editing)} title="Bevi una bottiglia"
                      style={{flex:"1 1 0",background:"linear-gradient(135deg, #3a1a5a, #7a3a9a)",
                        color:"#f0d0ff",border:"none",borderRadius:8,padding:"11px 8px",cursor:"pointer",
                        fontFamily:"'Cinzel', serif",fontSize:13,letterSpacing:1,fontWeight:700,
                        whiteSpace:"nowrap",textAlign:"center",
                      }}>🍷 BEVI</button>
                  )}
                  {/* CHIUDI */}
                  <button onClick={()=>{setModal(null);setEnrichData(null);setEnrichError(null);}}
                    style={{flex:"1 1 0",background:"transparent",border:`1px solid ${C.border}`,borderRadius:8,
                      color:C.textMuted,cursor:"pointer",padding:"11px 8px",
                      fontFamily:"'Cinzel', serif",fontSize:13,letterSpacing:1,whiteSpace:"nowrap",textAlign:"center",
                      transition:"border-color 0.15s,color 0.15s",}}
                    onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}
                    onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textMuted;}}
                  >CHIUDI</button>
                  {/* MODIFICA */}
                  <button onClick={()=>{setScanError(null);setModal("edit");}}
                    style={{flex:"1 1 0",background:`linear-gradient(135deg, #a07828, ${C.gold}, #a07828)`,
                      color:"#1a0800",border:"none",borderRadius:8,padding:"11px 8px",cursor:"pointer",
                      fontFamily:"'Cinzel', serif",fontSize:13,letterSpacing:1,fontWeight:700,
                      whiteSpace:"nowrap",textAlign:"center",
                    }}>MODIFICA</button>
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
              <h3 style={{fontFamily:"'Cinzel', serif",color:C.text,marginBottom:12,fontSize:18,letterSpacing:1}}>RIMUOVI VINO</h3>
              <p style={{color:C.textMuted,marginBottom:24,fontSize:18}}>Eliminare <strong style={{color:C.gold}}>{deleteConfirm.name}</strong>?</p>
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
              <h3 style={{fontFamily:"'Cinzel', serif",color:C.text,marginBottom:12,fontSize:18,letterSpacing:1}}>ELIMINA SCAFFALE</h3>
              <p style={{color:C.textMuted,marginBottom:10,fontSize:18}}>Eliminare <strong style={{color:C.gold}}>{deleteRackConfirm.name}</strong>?</p>
              <p style={{color:"#c07070",marginBottom:24,fontSize:14,fontStyle:"italic"}}>Le posizioni dei vini assegnati verranno azzerate.</p>
              <div style={{display:"flex",gap:12,justifyContent:"center"}}>
                <button className="btn-ghost" onClick={()=>setDeleteRackConfirm(null)}>ANNULLA</button>
                <button className="btn-gold" style={{background:"linear-gradient(135deg, #7a2020, #c04040)"}} onClick={()=>handleDeleteRack(deleteRackConfirm)}>ELIMINA</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DRINK POSITION MODAL ── */}
      {drinkModal && (() => {
        const wine = drinkModal;
        const rack = racks.find(r => r.id === wine.rackId);
        const positions = wine.positions || [];
        return (
          <div className="modal-overlay" onClick={() => setDrinkModal(null)}>
            <div className="modal-box" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
              <div style={{ height: 4, background: `linear-gradient(90deg, #7a2a9a, #c9953a)`, borderRadius: "14px 14px 0 0" }} />
              <div style={{ padding: "20px 22px" }}>
                <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, letterSpacing: 2, marginBottom: 6 }}>
                  🍷 QUALE BOTTIGLIA PRELEVI?
                </h2>
                <p style={{ fontSize: 17, color: C.textMuted, marginBottom: 20, fontFamily: "'EB Garamond', serif" }}>
                  {wine.name} · {wine.year}
                </p>

                {rack && positions.length > 0 ? (
                  <>
                    <p style={{ fontSize: 15, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginBottom: 14 }}>
                      SELEZIONA LA CELLA DA SVUOTARE — {rack.name}
                    </p>
                    {/* Col headers */}
                    <div style={{ display: "flex", gap: 4, marginBottom: 4, marginLeft: 30 }}>
                      {Array.from({ length: rack.cols }, (_, c) => (
                        <div key={c} style={{ width: 46, textAlign: "center", fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{c + 1}</div>
                      ))}
                    </div>
                    {Array.from({ length: rack.rows }, (_, r) => (
                      <div key={r} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                        <div style={{ width: 26, textAlign: "center", fontSize: 15, color: C.textFaint, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>{ROW_LABELS[r]}</div>
                        {Array.from({ length: rack.cols }, (_, c) => {
                          const pos = `${ROW_LABELS[r]}${c + 1}`;
                          const isThis = positions.includes(pos);
                          const otherWine = !isThis && wines.find(w => w.rackId === rack.id && (w.positions||[]).includes(pos));
                          const otc = otherWine ? typeColors[otherWine.type] : null;
                          return (
                            <div key={c}
                              onClick={() => isThis && commitDrink(wine, pos)}
                              title={isThis ? `Preleva da ${pos}` : otherWine ? otherWine.name : "Libera"}
                              style={{
                                width: 46, height: 38, borderRadius: 6,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                cursor: isThis ? "pointer" : "default",
                                background: isThis ? "rgba(122,42,154,0.3)" : otherWine ? `${otc.badge}99` : C.surface,
                                border: isThis ? `2px solid #9a4aba` : otherWine ? `1px solid ${otc.bar}` : `1px dashed ${C.border}`,
                                color: isThis ? "#e0b0ff" : otherWine ? otc.text : C.textFaint,
                                fontSize: 12, fontFamily: "'Cinzel', serif", fontWeight: isThis ? 700 : 400,
                                transition: "all 0.12s",
                              }}
                              onMouseEnter={e => { if (isThis) { e.currentTarget.style.background = "rgba(154,74,186,0.5)"; e.currentTarget.style.transform = "scale(1.1)"; }}}
                              onMouseLeave={e => { if (isThis) { e.currentTarget.style.background = "rgba(122,42,154,0.3)"; e.currentTarget.style.transform = ""; }}}
                            >
                              {isThis ? pos : otherWine ? "●" : ""}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    <p style={{ fontSize: 14, color: C.textFaint, fontStyle: "italic", marginTop: 12 }}>
                      Le celle viola sono le tue bottiglie di questo vino. Clicca su quella che stai prelevando.
                    </p>
                  </>
                ) : (
                  // Nessuna posizione assegnata — mostra solo conferma
                  <p style={{ fontSize: 17, color: C.textMuted, fontFamily: "'EB Garamond', serif", marginBottom: 20 }}>
                    Nessuna posizione assegnata. Verrà decrementata la quantità.
                  </p>
                )}

                <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 20 }}>
                  <button className="btn-ghost" onClick={() => setDrinkModal(null)}>ANNULLA</button>
                  {positions.length === 0 && (
                    <button className="btn-gold" onClick={() => commitDrink(wine, null)}>CONFERMA</button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════ STORICO VIEW ══════ */}
      {view === "logview" && (
        <div style={{ padding: "20px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
            <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, letterSpacing: 2 }}>STORICO BOTTIGLIE BEVUTE</h2>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 15, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{log.length} {log.length === 1 ? "bottiglia" : "bottiglie"}</div>
              <div style={{ fontSize: 12, color: C.textFaint, fontStyle: "italic", marginTop: 2 }}>Tocca una voce per modificarla</div>
            </div>
          </div>
          {log.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.4 }}>🍷</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 14 }}>NESSUNA BOTTIGLIA REGISTRATA</p>
              <p style={{ fontSize: 15, color: C.textFaint, marginTop: 8, fontStyle: "italic" }}>Le bottiglie bevute appariranno qui dopo averle registrate.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[...log].sort((a,b) => b.date.localeCompare(a.date)).map(entry => (
                <div key={entry.id}
                  onClick={() => { setLogEntry(entry); setLogModal("edit"); }}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", display: "flex", gap: 0 }}
                  className="wine-card">
                  {/* Foto miniatura */}
                  {entry.winePhoto && (
                    <div style={{ width: 60, flexShrink: 0, overflow: "hidden" }}>
                      <img src={entry.winePhoto} style={{ width: "100%", height: "100%", objectFit: "cover" }} alt={entry.wineName} />
                    </div>
                  )}
                  <div style={{ flex: 1, padding: "12px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                      <div>
                        <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 17, color: C.text, marginBottom: 2 }}>{entry.wineName}</h3>
                        <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic" }}>{entry.wineProducer} · {entry.wineYear}</p>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>
                          {new Date(entry.date).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
                        </div>
                        <div style={{ marginTop: 3 }}>
                          {[1,2,3,4,5].map(s => <span key={s} style={{ fontSize: 13, color: s <= entry.rating ? C.gold : C.border }}>★</span>)}
                        </div>
                      </div>
                    </div>
                    {entry.occasion && <p style={{ fontSize: 13, color: C.textFaint, marginBottom: 2 }}>📅 {entry.occasion}</p>}
                    {entry.companions && <p style={{ fontSize: 13, color: C.textFaint, marginBottom: 2 }}>👥 {entry.companions}</p>}
                    {entry.notes && <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic", marginTop: 4, lineHeight: 1.5 }}>"{entry.notes}"</p>}
                    <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                      {entry.wineType && <span style={{ fontSize: 11, color: C.textFaint, background: C.surface2, borderRadius: 20, padding: "2px 8px", fontFamily: "'Cinzel', serif" }}>{entry.wineType.toUpperCase()}</span>}
                      {entry.wineGrape && <span style={{ fontSize: 12, color: C.textFaint }}>🍇 {entry.wineGrape}</span>}
                      {!entry.finished && <span style={{ fontSize: 11, color: "#c0a040", background: "rgba(180,150,60,0.15)", borderRadius: 20, padding: "2px 8px", fontFamily: "'Cinzel', serif" }}>NON FINITA</span>}
                    </div>
                  </div>
                  <button onClick={e => { e.stopPropagation(); saveLog(log.filter(l => l.id !== entry.id)); showToast("Voce eliminata"); }}
                    style={{ alignSelf: "stretch", background: "none", border: "none", borderLeft: `1px solid ${C.bg}`, padding: "0 12px", cursor: "pointer", color: "#7a4040", fontSize: 16, transition: "color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.color="#d07070"}
                    onMouseLeave={e => e.currentTarget.style.color="#7a4040"}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── LOG MODAL ── */}
      {(logModal === "add" || logModal === "edit") && logEntry && (
        <div className="modal-overlay" onClick={() => setLogModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div style={{ padding: "20px 24px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: C.gold, letterSpacing: 2 }}>{logModal === "add" ? "🍷 REGISTRA LA BEVUTA" : "✏ MODIFICA VOCE"}</h2>
                <p style={{ fontSize: 14, color: C.textMuted, marginTop: 4, fontStyle: "italic" }}>{logEntry.wineName} · {logEntry.wineYear}</p>
              </div>
              <button onClick={() => setLogModal(null)} style={{ background: "none", border: "none", color: C.textFaint, cursor: "pointer", fontSize: 20 }}>✕</button>
            </div>
            <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>Data</label>
                <input type="date" style={inputStyle} value={logEntry.date}
                  onChange={e => setLogEntry(v => ({ ...v, date: e.target.value }))} />
              </div>
              <div>
                <label style={labelStyle}>Occasione</label>
                <input style={inputStyle} value={logEntry.occasion}
                  onChange={e => setLogEntry(v => ({ ...v, occasion: e.target.value }))}
                  placeholder="es. Cena in famiglia, Ristorante, Degustazione…" />
              </div>
              <div>
                <label style={labelStyle}>Con chi</label>
                <input style={inputStyle} value={logEntry.companions}
                  onChange={e => setLogEntry(v => ({ ...v, companions: e.target.value }))}
                  placeholder="es. Famiglia, Amici, Da solo…" />
              </div>
              <div>
                <label style={labelStyle}>Valutazione della serata</label>
                <div style={{ display: "flex", gap: 4 }}>
                  {[1,2,3,4,5].map(s => (
                    <span key={s} onClick={() => setLogEntry(v => ({ ...v, rating: s }))} style={{
                      cursor: "pointer", fontSize: 28,
                      color: s <= logEntry.rating ? C.gold : C.border,
                      transition: "color 0.15s", userSelect: "none",
                    }}>★</span>
                  ))}
                </div>
              </div>
              <div>
                <label style={labelStyle}>Note del momento</label>
                <textarea style={{ ...inputStyle, minHeight: 80, resize: "vertical", lineHeight: 1.6 }}
                  value={logEntry.notes}
                  onChange={e => setLogEntry(v => ({ ...v, notes: e.target.value }))}
                  placeholder="Impressioni, abbinamento cibo, stato del vino…" />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="checkbox" id="finished" checked={logEntry.finished}
                  onChange={e => setLogEntry(v => ({ ...v, finished: e.target.checked }))}
                  style={{ width: 18, height: 18, cursor: "pointer", accentColor: C.gold }} />
                <label htmlFor="finished" style={{ ...labelStyle, marginBottom: 0, cursor: "pointer" }}>Bottiglia finita</label>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", paddingTop: 4 }}>
                <button className="btn-ghost" onClick={() => setLogModal(null)}>{logModal === "edit" ? "ANNULLA" : "SALTA"}</button>
                {logModal === "edit" && (
                  <button className="btn-danger" onClick={() => {
                    saveLog(log.filter(l => l.id !== logEntry.id));
                    setLogModal(null);
                    showToast("Voce eliminata");
                  }}>ELIMINA</button>
                )}
                <button className="btn-gold" onClick={() => {
                  if (logModal === "edit") {
                    saveLog(log.map(l => l.id === logEntry.id ? logEntry : l));
                    showToast("✏ Voce aggiornata");
                  } else {
                    saveLog([logEntry, ...log]);
                    showToast("🍷 Bevuta registrata nello storico");
                  }
                  setLogModal(null);
                }}>{logModal === "edit" ? "SALVA" : "SALVA NELLO STORICO"}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── LIGHTBOX ── */}
      {lightboxPhoto && (
        <div onClick={() => setLightboxPhoto(null)} style={{
          position:"fixed", inset:0, background:"rgba(0,0,0,0.95)",
          display:"flex", alignItems:"center", justifyContent:"center",
          zIndex:500, cursor:"zoom-out", padding:16,
        }}>
          <button onClick={() => setLightboxPhoto(null)} style={{
            position:"absolute", top:16, right:16,
            background:"rgba(255,255,255,0.15)", border:"none", borderRadius:"50%",
            width:40, height:40, color:"#fff", fontSize:18, cursor:"pointer",
            display:"flex", alignItems:"center", justifyContent:"center",
          }}>✕</button>
          <img src={lightboxPhoto} alt="Etichetta" style={{
            maxWidth:"100%", maxHeight:"90vh", objectFit:"contain",
            borderRadius:8, boxShadow:"0 0 60px rgba(0,0,0,0.8)",
          }} onClick={e => e.stopPropagation()}/>
        </div>
      )}

      {/* Toast */}
      {toast&&(
        <div style={{position:"fixed",bottom:26,right:26,background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"13px 20px",color:C.gold,fontFamily:"'Cinzel', serif",fontSize:16,letterSpacing:1,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",zIndex:300,animation:"fadeUp 0.2s ease"}}>
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
