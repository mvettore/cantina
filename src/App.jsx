import { useState, useRef, useEffect } from "react";

const WINE_TYPES = ["Rosso", "Bianco", "Rosato", "Spumante", "Dolce", "Passito"];
const REGIONS = [
  // Italia
  "Piemonte", "Valle d'Aosta", "Liguria", "Lombardia", "Trentino-Alto Adige", "Friuli-Venezia Giulia", "Veneto",
  "Emilia-Romagna", "Toscana", "Umbria", "Marche", "Lazio", "Abruzzo", "Molise",
  "Campania", "Puglia", "Basilicata", "Calabria", "Sicilia", "Sardegna",
  // Estero
  "Francia", "Germania", "Spagna", "Portogallo", "California", "Sud Africa", "Cile", "Argentina",
  "Altro",
];
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

// Migrazione dati vecchi
function migrateWines(wines) {
  const seen = new Set();
  return wines.map(w => {
    // 1. position (singolo) → positions (array)
    if (w.position !== undefined && w.positions === undefined) {
      const { position, ...rest } = w;
      w = { ...rest, positions: position ? [position] : [] };
    }
    if (w.positions === undefined) w = { ...w, positions: [] };
    // 2. rackId + positions → rackSlots [{rackId, positions}]
    if (w.rackSlots === undefined) {
      const { rackId, positions, ...rest } = w;
      w = { ...rest, rackSlots: rackId ? [{ rackId, positions: positions || [] }] : [] };
    }
    // 3. photo (singola) → photos (array)
    if (w.photos === undefined) {
      const { photo, ...rest } = w;
      w = { ...rest, photos: photo ? [photo] : [] };
    }
    return w;
  }).filter(w => {
    // 3. deduplica per id — rimuove doppioni causati da bug di salvataggio
    if (seen.has(w.id)) return false;
    seen.add(w.id);
    return true;
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
  "Rosso":    { bar: "#c0102a", badge: "#6a2020", text: "#fcd8d8" }, // rubino
  "Bianco":   { bar: "#c8b84a", badge: "#4a4a20", text: "#faf0c0" }, // paglierino
  "Rosato":   { bar: "#d4607a", badge: "#6a2040", text: "#fcd8e8" }, // rosato
  "Spumante": { bar: "#a0c4a0", badge: "#204a60", text: "#c8eafa" }, // verde acqua/perlage
  "Dolce":    { bar: "#e0a030", badge: "#5a3820", text: "#fae0b0" }, // miele
  "Passito":  { bar: "#c07820", badge: "#3a1860", text: "#e0c8fa" }, // ambra
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
async function scanLabel(base64DataUrl, base64DataUrl2 = null) {
  const base64    = base64DataUrl.split(",")[1];
  const mediaType = base64DataUrl.split(";")[0].split(":")[1] || "image/jpeg";
  const base64_2    = base64DataUrl2 ? base64DataUrl2.split(",")[1] : null;
  const mediaType_2 = base64DataUrl2 ? (base64DataUrl2.split(";")[0].split(":")[1] || "image/jpeg") : null;

  const isNetlify = window.location.hostname !== "localhost" &&
                    window.location.hostname !== "127.0.0.1";

  if (isNetlify) {
    const resp = await fetch("/.netlify/functions/scan-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64, mediaType, base64_2, mediaType_2 }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Errore server ${resp.status}`);
    }
    return await resp.json();
  } else {
    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Imposta VITE_ANTHROPIC_API_KEY in .env.local");

    const prompt = `Sei un esperto enologo. Analizza quest${base64_2 ? "e etichette" : "a etichetta"} di vino.
Restituisci ESCLUSIVAMENTE un oggetto JSON valido con questi campi:
{ "name": "...", "producer": "...", "year": 2019, "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito", "region": "...", "grape": "...", "notes": "...", "price": null }
Se un campo non è determinabile usa null.`;

    const images = [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      ...(base64_2 ? [{ type: "image", source: { type: "base64", media_type: mediaType_2, data: base64_2 } }] : []),
      { type: "text", text: prompt },
    ];

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content: images }] }),
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

const TypeBadge = ({ type, small }) => {
  const c = typeColors[type] || { badge: "#555", text: "#eee" };
  if (!type) return null;
  return (
    <span style={{ background: c.badge, color: c.text,
      padding: small ? "1px 7px" : "4px 13px",
      borderRadius: 20,
      fontSize: small ? 14 : 17,
      fontFamily: "'Cinzel', serif", letterSpacing: small ? 0.5 : 1, fontWeight: 700 }}>
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
  region: "", grape: "", type: "", denomination: "",
  rating: 3, notes: "", quantity: 1, price: "", rackSlots: [], photos: [], enrichment: null,
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
  const [filterUnracked, setFilterUnracked] = useState(false);
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
  const [undoState, setUndoState] = useState(null); // {msg, restore: fn}
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [drinkModal, setDrinkModal] = useState(null);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [cantinaName, setCantinaName] = useState(() => loadLocal('cantina-name', 'CANTINA VETTORELLO'));
  const [editingName, setEditingName] = useState(false);
  const [viewFromPos, setViewFromPos] = useState(null); // posizione rack che ha aperto il modal view
  const [pullY, setPullY] = useState(0);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const pullStartY = useRef(0);
  const [pendingDrink, setPendingDrink] = useState(null); // {wine, newQty, newSlots}
  const [log, setLog] = useState(() => loadLocal(LOG_KEY, []));
  const [logModal, setLogModal] = useState(null); // wine being logged
  const [logEntry, setLogEntry] = useState(null); // current entry being edited
  const [logView, setLogView] = useState("list"); // "list" | "entry"
  const [logSearch, setLogSearch] = useState("");
  const [viewingEntry, setViewingEntry] = useState(null); // wine to drink from
  const [enriching, setEnriching] = useState(false);
  const [enrichData, setEnrichData] = useState(null);
  const [enrichError, setEnrichError] = useState(null);
  const scanInputRef    = useRef(null);
  const secondPhotoRef  = useRef(null);
  const addPhotoRef     = useRef(null);
  const tastingPhotoRef = useRef(null);
  const [firstPhotoData, setFirstPhotoData] = useState(null); // {scanDataUrl, hiResDataUrl}
  const nextWineId = useRef(Math.max(...wines.map(w => w.id), 99) + 1);
  const nextRackId = useRef(Math.max(...racks.map(r => r.id), 99) + 1);
  const [searchBarVisible, setSearchBarVisible] = useState(true);
  const lastScrollY = useRef(0);

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
            setTimeout(() => autoEnrich(wine), i * 3000); // 3s di gap tra una e l'altra
          });
        }
      }
    });
  }, []);

  const doCloudRefresh = () => {
    if (!IS_NETLIFY) return Promise.resolve();
    return cloudLoad().then(data => {
      if (!data) return;
      if (data.wines) { setWines(migrateWines(data.wines)); saveLocal(STORAGE_KEY, data.wines); }
      if (data.racks) { setRacks(data.racks); saveLocal(RACKS_KEY, data.racks); }
      if (data.log)   { setLog(data.log);     saveLocal(LOG_KEY, data.log); }
    });
  };

  // Ri-sincronizza dal cloud quando l'app torna in foreground (es. da background su iOS)
  useEffect(() => {
    if (!IS_NETLIFY) return;
    const handleVisibility = () => { if (document.visibilityState === 'visible') doCloudRefresh(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const PULL_THRESHOLD = 72;
  const onPullStart = (e) => { pullStartY.current = e.touches[0].clientY; };
  const onPullMove  = (e) => {
    const el = e.currentTarget;
    if (el.scrollTop > 0) return;
    const dy = e.touches[0].clientY - pullStartY.current;
    if (dy > 0) setPullY(Math.min(dy, PULL_THRESHOLD * 1.4));
  };
  const onPullEnd   = () => {
    if (pullY >= PULL_THRESHOLD && !pullRefreshing) {
      setPullRefreshing(true);
      doCloudRefresh().finally(() => { setPullRefreshing(false); setPullY(0); });
    } else {
      setPullY(0);
    }
  };
  const pullHandlers = IS_NETLIFY ? { onTouchStart: onPullStart, onTouchMove: onPullMove, onTouchEnd: onPullEnd } : {};
  const pullIndicatorH = pullRefreshing ? 44 : Math.round(pullY * 0.55);
  const PullIndicator = () => pullIndicatorH > 4 ? (
    <div style={{ display:"flex", justifyContent:"center", alignItems:"center", height: pullIndicatorH, overflow:"hidden", transition: pullRefreshing ? "none" : "height 0.2s" }}>
      <div style={{ width:22, height:22, border:`2px solid rgba(201,149,58,0.3)`, borderTopColor:C.gold, borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
    </div>
  ) : null;

  const saveWines = (w) => {
    // Deduplicazione difensiva: in caso di id doppi, tieni l'ultimo inserito
    const seen = new Set();
    const deduped = [...w].reverse().filter(wine => {
      if (seen.has(wine.id)) return false;
      seen.add(wine.id);
      return true;
    }).reverse();
    setWines(deduped);
    saveLocal(STORAGE_KEY, deduped);
    cloudSave({ wines: deduped });
  };
  const saveRacks = (r) => { setRacks(r); saveLocal(RACKS_KEY,  r); cloudSave({ racks: r }); };
  const saveLog   = (l) => { setLog(l);   saveLocal(LOG_KEY,   l); cloudSave({ log:   l }); };
  const saveName  = (n) => { setCantinaName(n); saveLocal('cantina-name', n); };
  const showToast = (msg) => { setToast(msg); setUndoState(null); setTimeout(() => setToast(null), 3000); };
  const showUndoToast = (msg, restore) => {
    setToast(msg);
    setUndoState({ restore });
    const t = setTimeout(() => { setToast(null); setUndoState(null); }, 5000);
    setUndoState({ restore, timer: t });
  };

  const filtered = wines
    .filter(w => filterType === "Tutti" || w.type === filterType)
    .filter(w => filterAging === "Tutti" || getAgingStatus(w)?.s === filterAging)
    .filter(w => !filterUnracked || (w.rackSlots||[]).every(s => (s.positions||[]).length === 0))
    .filter(w => {
      const q = search.toLowerCase();
      // Costruisce array di tutti i campi testuali ricercabili
      const fields = [
        w.name || "",
        w.denomination || "",
        w.producer || "",
        w.region || "",
        w.grape || "",
        w.type || "",
        w.notes || "",
        w.year ? String(w.year) : "",
        w.price ? String(w.price) : "",
        ...(w.rackSlots||[]).flatMap(s => s.positions||[]),
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

  // ── Esegue OCR su 1 o 2 foto e aggiorna il form ──
  const doScanAndFill = async (photo1, photo2 = null) => {
    const info = await scanLabel(photo1.scanDataUrl, photo2?.scanDataUrl || null);
    const cropped1 = await autoCropLabel(photo1.hiResDataUrl);
    const thumb1 = cropped1 || photo1.hiResDataUrl;
    const photos = [thumb1];
    if (photo2) {
      const cropped2 = await autoCropLabel(photo2.hiResDataUrl);
      photos.push(cropped2 || photo2.hiResDataUrl);
    }
    setEditing(prev => ({
      ...prev,
      name:         info.name         || prev.name,
      denomination: info.denomination || prev.denomination || "",
      producer:     info.producer     || prev.producer,
      year:         info.year         || prev.year,
      type:         WINE_TYPES.includes(info.type) ? info.type : prev.type,
      region:       info.region       || prev.region,
      grape:        info.grape        || prev.grape,
      notes:        info.notes        || prev.notes,
      price:        info.price != null ? String(info.price) : prev.price,
      photos:       [...photos, ...(prev.photos||[]).slice(photos.length)],
    }));
    showToast(photo2 ? "✨ Etichette riconosciute!" : (cropped1 ? "✨ Etichetta riconosciuta e ritagliata!" : "✨ Etichetta riconosciuta!"));
  };

  // ── Prima foto: ridimensiona e mostra il prompt per la seconda ──
  const handleScanFile = async (file) => {
    if (!file) return;
    setScanError(null);
    setScanning(true);
    try {
      const scanDataUrl  = await resizeImage(file, 700, 0.82);
      const hiResDataUrl = await resizeImage(file, 1800, 0.93);
      setFirstPhotoData({ scanDataUrl, hiResDataUrl });
    } catch (err) {
      console.error(err);
      setScanError("Non sono riuscito a elaborare la foto. Riprova.");
    } finally {
      setScanning(false);
    }
  };

  // ── Seconda foto scattata: scansiona entrambe ──
  const handleSecondPhoto = async (file) => {
    if (!file || !firstPhotoData) return;
    setScanError(null);
    setScanning(true);
    try {
      const scanDataUrl2  = await resizeImage(file, 700, 0.82);
      const hiResDataUrl2 = await resizeImage(file, 1800, 0.93);
      await doScanAndFill(firstPhotoData, { scanDataUrl: scanDataUrl2, hiResDataUrl: hiResDataUrl2 });
    } catch (err) {
      console.error(err);
      setScanError("Non sono riuscito a leggere le etichette. Riprova.");
    } finally {
      setScanning(false);
      setFirstPhotoData(null);
    }
  };

  // ── Salta la seconda foto: scansiona solo la prima ──
  const handleSkipSecondPhoto = async () => {
    if (!firstPhotoData) return;
    setScanError(null);
    setScanning(true);
    try {
      await doScanAndFill(firstPhotoData, null);
    } catch (err) {
      console.error(err);
      setScanError("Non sono riuscito a leggere l'etichetta. Riprova con una foto più nitida.");
    } finally {
      setScanning(false);
      setFirstPhotoData(null);
    }
  };

  // Aggiunge una foto extra (retro, dettaglio) senza riconoscimento OCR
  const handleAddPhoto = async (file) => {
    if (!file) return;
    try {
      const hiRes = await resizeImage(file, 1800, 0.93);
      setEditing(prev => ({ ...prev, photos: [...(prev.photos||[]), hiRes] }));
    } catch (err) {
      console.error(err);
    }
  };

  // Bevi una bottiglia: apre il selettore di posizione se ne ha, altrimenti decrementa
  const handleDrinkOne = (wine) => {
    const allPositions = (wine.rackSlots||[]).flatMap(s => s.positions||[]);
    // Se c'è una sola posizione (o nessuna), non serve chiedere quale svuotare
    if (allPositions.length > 1) {
      setDrinkModal(wine);
    } else {
      commitDrink(wine, allPositions[0] || null);
    }
  };

  // Conferma la bevuta: memorizza il pending e apre il form storico
  // La cantina viene aggiornata SOLO quando si salva il log (o si salta)
  const commitDrink = (wine, posToRemove) => {
    const newQty = wine.quantity - 1;
    let newSlots = (wine.rackSlots||[]);
    if (posToRemove) {
      newSlots = newSlots.map(s => ({ ...s, positions: (s.positions||[]).filter(p => p !== posToRemove) }));
    } else {
      // Rimuovi l'ultima posizione dall'ultimo slot non vuoto
      const lastNonEmpty = [...newSlots].reverse().findIndex(s => (s.positions||[]).length > 0);
      if (lastNonEmpty >= 0) {
        const idx = newSlots.length - 1 - lastNonEmpty;
        newSlots = newSlots.map((s, i) => i === idx ? { ...s, positions: s.positions.slice(0, -1) } : s);
      }
    }

    // Salva il pending — verrà applicato al salvataggio o allo skip
    setPendingDrink({ wine, newQty, newSlots });
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
      winePhotos: wine.photos || [],
      tastingPhotos: [],
      date: new Date().toISOString().split("T")[0],
      occasion: "",
      companions: "",
      // Scheda degustazione AIS
      rating: 0,
      vista_limpidezza: "",
      vista_colore: "",
      vista_intensita_colore: "",
      olfatto_intensita: "",
      olfatto_qualita: "",
      olfatto_descrizione: "",
      gusto_corpo: "",
      gusto_acidita: "",
      gusto_tannini: "",
      gusto_persistenza: "",
      gusto_equilibrio: "",
      notes: wine.notes || "",
      wineEnrichment: wine.enrichment || null,
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
      const updatedList = wines.map(w => w.id === wine.id ? updated : w);
      saveWines(updatedList);
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
    if (!editing.type) { showToast("Seleziona una tipologia"); return; }
    if (!editing.region) { showToast("Seleziona una regione"); return; }
    if (modal === "add") {
      const wine = { ...editing, id: nextWineId.current++ };
      const newList = [...wines.filter(w => w.id !== wine.id), wine];
      saveWines(newList);
      setModal(null);
      showToast(`"${wine.name}" aggiunto — analisi in corso…`);
      setTimeout(() => autoEnrich(wine), 500);
    } else {
      saveWines(wines.map(w => w.id === editing.id ? editing : w));
      showToast(`"${editing.name}" aggiornato`);
      setModal(null);
    }
  };

  // Analisi automatica in background senza bloccare la UI
  const autoEnrich = async (wine) => {
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
      setWines(current => {
        const newList = current.map(w => w.id === wine.id ? updated : w);
        saveLocal(STORAGE_KEY, newList);
        cloudSave({ wines: newList });
        return newList;
      });
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
    const prevRacks = racks;
    const prevWines = wines;
    const newRacks = racks.filter(r => r.id !== rack.id);
    const newWines = wines.map(w => ({ ...w, rackSlots: (w.rackSlots||[]).filter(s => s.rackId !== rack.id) }));
    saveRacks(newRacks);
    saveWines(newWines);
    setDeleteRackConfirm(null);
    showUndoToast(`Scaffale "${rack.name}" eliminato`, () => { saveRacks(prevRacks); saveWines(prevWines); });
  };

  const getWineAtPosition = (rackId, pos) => wines.find(w => (w.rackSlots||[]).some(s => s.rackId === rackId && (s.positions||[]).includes(pos)));

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
    <div>
      <div style={{ display: "flex", gap: 3, marginBottom: 3, marginLeft: 24 }}>
        {Array.from({ length: rack.cols }, (_, c) => (
          <div key={c} style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{c + 1}</div>
        ))}
      </div>
      {Array.from({ length: rack.rows }, (_, r) => (
        <div key={r} style={{ display: "flex", alignItems: "center", gap: 3, marginBottom: 3 }}>
          <div style={{ width: 22, flexShrink: 0, textAlign: "center", fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif", fontWeight: 700 }}>{ROW_LABELS[r]}</div>
          {Array.from({ length: rack.cols }, (_, c) => {
            const pos = `${ROW_LABELS[r]}${c + 1}`;
            const isThis = (highlightPositions||[]).includes(pos);
            const occupant = wines.find(w => (w.rackSlots||[]).some(s => s.rackId === rack.id && (s.positions||[]).includes(pos)));
            const isOther = occupant && occupant.id !== editing?.id;
            const otc = isOther ? typeColors[occupant.type] : null;
            return (
              <div key={c} title={isThis ? "Qui!" : isOther ? occupant.name : pos} style={{
                flex: 1, minWidth: 0, height: 28, borderRadius: 4,
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
    <div style={{ height: "100svh", display: "flex", flexDirection: "column", overflow: "hidden", background: C.bg, fontFamily: "'EB Garamond', serif", color: C.text, fontSize: 20 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow: hidden; height: 100%; max-width: 100vw; }
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
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.72); display: flex; align-items: flex-end; justify-content: center; z-index: 200; padding-top: env(safe-area-inset-top, 44px); overflow: hidden; backdrop-filter: blur(4px); }
        @media (min-width: 600px) { .modal-overlay { align-items: center; padding: 8px; } }
        .modal-box { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; width: 100%; max-width: min(98vw, 1100px); max-height: 96svh; overflow-y: auto; -webkit-overflow-scrolling: touch; box-shadow: 0 30px 80px rgba(0,0,0,0.6); animation: fadeUp 0.22s ease; padding-bottom: env(safe-area-inset-bottom, 16px); }
        @keyframes fadeUp { from { opacity:0; transform: translateY(18px) scale(0.97); } to { opacity:1; transform: none; } }

        @media (max-width: 600px) {
          .wine-card { font-size: 15px !important; }
          .wine-card h3 { font-size: 17px !important; }
          .wine-card p  { font-size: 14px !important; }
          .tab-btn { padding: 5px 10px !important; font-size: 12px !important; }
          .nav-btn  { padding: 9px 14px !important; font-size: 13px !important; }
          .modal-box { border-radius: 20px 20px 0 0 !important; max-height: 95svh !important; }
          .mobile-header-title { font-size: 18px !important; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .rack-card { background: ${C.surface2}; border: 1px solid ${C.border}; border-radius: 12px; overflow: hidden; }
        .action-btn { flex: 1; background: none; border: none; cursor: pointer; padding: 10px; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: color 0.15s, background 0.15s; }

        /* scan button */
        .btn-scan {
          display: flex; align-items: center; justify-content: center; gap: 8px;
          min-width: 0; padding: 10px 12px; border-radius: 8px; cursor: pointer;
          font-family: 'Cinzel', serif; font-size: 13px; font-weight: 600; letter-spacing: 1px;
          border: 2px dashed ${C.gold};
          background: rgba(201,149,58,0.07);
          color: ${C.gold}; transition: all 0.2s;
        }
        .btn-scan:hover { background: rgba(201,149,58,0.14); border-style: solid; }
        .btn-scan:disabled { opacity: 0.5; cursor: not-allowed; }
        .spinner { width: 18px; height: 18px; border: 2px solid rgba(201,149,58,0.3); border-top-color: ${C.gold}; border-radius: 50%; animation: spin 0.8s linear infinite; }
      `}</style>

      {/* ── NAV ── */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 8px", paddingTop: "env(safe-area-inset-top, 0px)", display: "flex", overflowX: "auto", WebkitOverflowScrolling: "touch", flexShrink: 0 }}>
        {[["catalog","📋  CATALOGO"],["racks","🗄  SCAFFALI"],["stats","📊  STATISTICHE"],["logview","📖  STORICO"]].map(([v,l]) => (
          <button key={v} className={`nav-btn ${view===v?"active":""}`} onClick={() => setView(v)}>{l}</button>
        ))}
      </div>

      {/* ══════ CATALOG VIEW ══════ */}
      {view === "catalog" && <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
        {/* Barra ricerca — si nasconde scorrendo giù, riappare scorrendo su */}
        <div style={{
          overflow: "hidden", flexShrink: 0,
          maxHeight: searchBarVisible ? "160px" : "0px",
          transition: "max-height 0.22s ease",
        }}>
        <div style={{ padding: "7px 12px", background: C.surface, borderBottom: `1px solid ${C.border}` }}>
          {/* Barra ricerca + toggle filtri */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, position: "relative" }}>
              <span style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", color: C.textFaint, fontSize: 14 }}>🔍</span>
              <input placeholder="Cerca in tutti i campi…" value={search} onChange={e => setSearch(e.target.value)}
                style={{ ...inputStyle, paddingLeft: 34, paddingRight: search ? 34 : 12, padding: "7px 12px", paddingLeft: 34, fontSize: 16 }} />
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
            {(filterType !== "Tutti" || filterAging !== "Tutti" || filterUnracked) && (
              <span style={{ fontSize: 12, color: C.gold, fontFamily: "'Cinzel', serif", whiteSpace: "nowrap" }}>
                {[filterType !== "Tutti" ? filterType : null, filterAging !== "Tutti" ? filterAging : null, filterUnracked ? "Senza scaffale" : null].filter(Boolean).join(" · ")}
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
              {/* Senza scaffale */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button className="tab-btn" onClick={() => setFilterUnracked(v => !v)} style={{
                  color: filterUnracked ? C.gold : C.textFaint,
                  background: filterUnracked ? "rgba(201,149,58,0.14)" : "none",
                  border: filterUnracked ? `1px solid rgba(201,149,58,0.4)` : "1px solid transparent",
                }}>🗄 SENZA SCAFFALE</button>
              </div>
              {/* Ordina */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, minWidth: 38 }}>ORDINA</span>
                <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inputStyle, width: "auto", fontSize: 14, padding: "7px 10px" }}>
                  <option value="name">Nome</option>
                  <option value="year">Annata</option>
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
        </div>{/* fine wrapper search collassabile */}

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px", paddingBottom: 100 }}
          {...pullHandlers}
          onScroll={e => {
            const y = e.currentTarget.scrollTop;
            if (y > lastScrollY.current + 8) setSearchBarVisible(false);
            else if (y < lastScrollY.current - 8) setSearchBarVisible(true);
            lastScrollY.current = y;
          }}
        >
          <PullIndicator />
          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.4 }}>🍷</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 15 }}>{wines.length===0?"LA CANTINA È VUOTA":"NESSUN RISULTATO"}</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 18 }}>
              {filtered.map(wine => {
                const tc = typeColors[wine.type] || { bar: "#888" };
                return (
                  <div key={wine.id} className="wine-card" style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", boxShadow: "0 3px 12px rgba(0,0,0,0.25)" }}
                    onClick={() => { setEditing({...wine}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setModal("view"); }}>
                    <div style={{ height: 5, background: tc.bar }} />

                    <div style={{display:"flex",minHeight:0}}>
                      {/* Foto verticale */}
                      {(wine.photos||[])[0] && (
                        <div onClick={e=>{e.stopPropagation();setLightboxPhoto((wine.photos||[])[0]);}}
                          style={{flexShrink:0,width:56,cursor:"zoom-in",overflow:"hidden",
                            position:"relative",borderRight:`1px solid ${C.border}`}}>
                          <img src={(wine.photos||[])[0]} alt={wine.name}
                            style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",display:"block"}}/>
                        </div>
                      )}
                      <div style={{flex:1,minWidth:0,padding:"9px 12px 9px",display:"flex",flexDirection:"column",justifyContent:"space-between"}}>

                        {/* Blocco top: NOME + denominazione + bt */}
                        <div>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:6}}>
                            <div style={{fontFamily:"'Cinzel',serif",fontSize:20,fontWeight:700,color:C.text,lineHeight:1.2,
                              overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",flex:1,minWidth:0}}>{wine.name}</div>
                            <span style={{
                              background:wine.quantity===0?"rgba(180,60,60,0.25)":wine.quantity<=2?"rgba(180,150,60,0.25)":"rgba(60,150,60,0.2)",
                              color:wine.quantity===0?"#d07070":wine.quantity<=2?"#c0b040":"#70c070",
                              padding:"1px 8px",borderRadius:20,fontSize:16,flexShrink:0,
                              fontFamily:"'Cinzel',serif",fontWeight:700,
                            }}>{wine.quantity}bt</span>
                          </div>
                          <div style={{fontFamily:"'Cinzel',serif",fontSize:13,color:C.textMuted,fontWeight:400,marginTop:2,
                            minHeight:"1.3em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {wine.denomination||""}
                          </div>
                        </div>

                        {/* Blocco mid: produttore · anno (+ prezzo) */}
                        <div>
                          <p style={{fontFamily:"'Cinzel',serif",fontSize:16,
                            color:C.text,margin:0,lineHeight:1.3,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {[wine.producer, wine.year].filter(Boolean).join(" · ")}
                          </p>
                          {wine.price && (
                            <p style={{fontFamily:"'Cinzel',serif",fontSize:14,color:C.textMuted,margin:"2px 0 0"}}>€{wine.price}</p>
                          )}
                        </div>

                        {/* Blocco bottom: scaffale + stato invecchiamento */}
                        {((wine.rackSlots||[]).some(s=>(s.positions||[]).length>0) || getAgingStatus(wine)) && (
                          <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
                            {(()=>{
                              const slotsWithPos=(wine.rackSlots||[]).filter(s=>(s.positions||[]).length>0);
                              if(!slotsWithPos.length) return null;
                              const first=slotsWithPos[0];
                              const sr=racks.find(r=>r.id===first.rackId);
                              if(!sr) return null;
                              const pos=first.positions;
                              const posLabel=pos.length>1?`${pos[0]} +${pos.length-1}`:pos[0];
                              const extraSlots=slotsWithPos.length-1;
                              const abbr=sr.name.split(/\s+/).map(w=>w.length<=2?w.toUpperCase():w[0].toUpperCase()).join("");
                              return(
                                <span style={{fontSize:12,color:C.gold,fontFamily:"'Cinzel',serif",
                                  background:"rgba(201,149,58,0.1)",border:`1px solid rgba(201,149,58,0.2)`,
                                  borderRadius:20,padding:"2px 8px",fontWeight:600}}>
                                  🗄 {abbr} {posLabel}{extraSlots>0?` +${extraSlots}`:""}
                                </span>
                              );
                            })()}
                            {(()=>{const ag=getAgingStatus(wine);if(!ag)return null;
                              const age=new Date().getFullYear()-wine.year;
                              return(
                                <span style={{fontSize:12,color:ag.c,fontFamily:"'Cinzel',serif",fontWeight:700,
                                  background:`${ag.c}12`,border:`1px solid ${ag.c}35`,
                                  borderRadius:20,padding:"2px 8px"}}>
                                  {ag.s==="Giovane"?"🌱":ag.s==="Apice"?"⭐":ag.s==="Maturo"?"🍂":"📉"} {age}a
                                </span>
                              );
                            })()}
                          </div>
                        )}

                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>}

      {/* ══════ RACKS VIEW ══════ */}
      {view === "racks" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", paddingBottom: 100 }} {...pullHandlers}>
          <PullIndicator />
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.gold, letterSpacing: 2, marginBottom: 6 }}>I MIEI SCAFFALI</h2>
            <p style={{ fontSize: 15, color: C.textMuted, fontStyle: "italic" }}>Ogni cella è una posizione A1, B3… Clicca su una bottiglia per i dettagli.</p>
          </div>
          {racks.length === 0 && (
            <div style={{ textAlign: "center", padding: "60px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.4 }}>🗄</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 15 }}>NESSUNO SCAFFALE CONFIGURATO</p>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            {racks.map(rack => {
              const occPositions = wines.flatMap(w => (w.rackSlots||[]).filter(s => s.rackId === rack.id).flatMap(s => s.positions||[]));
              return (
                <div key={rack.id} className="rack-card">
                  <div style={{ padding: "17px 22px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.text, letterSpacing: 1 }}>{rack.name}</h3>
                      <p style={{ fontSize: 16, color: C.textFaint, marginTop: 5 }}>{rack.rows} file ({ROW_LABELS[0]}–{ROW_LABELS[rack.rows-1]}) × {rack.cols} colonne · {occPositions.length}/{rack.rows*rack.cols} occupate</p>
                    </div>
                    <div style={{ display: "flex", gap: 9 }}>
                      <button className="btn-sm" style={{fontSize:12,padding:"5px 10px"}} onClick={() => { setEditingRack({...rack}); setRackModal("edit"); }}>✏</button>
                      <button className="btn-danger" onClick={() => setDeleteRackConfirm(rack)}>✕</button>
                    </div>
                  </div>
                  <div style={{ padding: "12px 10px" }}>
                    <div style={{ display: "flex", gap: 3, marginBottom: 3, marginLeft: 26 }}>
                      {Array.from({length:rack.cols},(_,c)=>(
                        <div key={c} style={{ flex:1, minWidth:0, textAlign:"center", fontSize:12, color:C.textFaint, fontFamily:"'Cinzel', serif", fontWeight:600 }}>{c+1}</div>
                      ))}
                    </div>
                    {Array.from({length:rack.rows},(_,r)=>(
                      <div key={r} style={{ display:"flex", alignItems:"stretch", gap:3, marginBottom:3 }}>
                        <div style={{ width:22, flexShrink:0, textAlign:"center", fontSize:13, color:C.textFaint, fontFamily:"'Cinzel', serif", fontWeight:700, display:"flex", alignItems:"center", justifyContent:"center" }}>{ROW_LABELS[r]}</div>
                        {Array.from({length:rack.cols},(_,c)=>{
                          const pos = `${ROW_LABELS[r]}${c+1}`;
                          const wine = getWineAtPosition(rack.id, pos);
                          const tc = wine?typeColors[wine.type]:null;
                          return (
                            <div key={c} onClick={()=>wine?(setEditing({...wine}),setViewFromPos(pos),setEnrichData(null),setEnrichError(null),setModal("view")):(setEditing({...emptyWine(),rackSlots:[{rackId:rack.id,positions:[pos]}]}),setScanError(null),setModal("add"))}
                              title={wine?`${wine.name} (${wine.year})`:`Libera — ${pos}`}
                              style={{ flex:1,minWidth:0,height:52,borderRadius:6,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",background:wine?`${tc.badge}dd`:C.surface,border:wine?`1px solid ${tc.bar}`:`1px dashed ${C.border}`,color:wine?tc.text:C.textFaint,transition:"all 0.12s",fontSize:10,fontFamily:"'Cinzel', serif",overflow:"hidden",padding:"2px 2px" }}
                              onMouseEnter={e=>{if(wine){e.currentTarget.style.transform="scale(1.04)";e.currentTarget.style.boxShadow="0 4px 12px rgba(0,0,0,0.4)";}else{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}}
                              onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";e.currentTarget.style.borderColor=wine?tc.bar:C.border;e.currentTarget.style.color=wine?tc.text:C.textFaint;}}
                            >
                              {wine?(
                                <>
                                  <span style={{fontWeight:700,lineHeight:1.1,textAlign:"center",width:"100%",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis",fontSize:11,fontFamily:"'Cinzel',serif",padding:"0 2px"}}>{wine.name}</span>
                                  <span style={{fontSize:10,marginTop:1,fontFamily:"'Cinzel',serif",opacity:0.85}}>{wine.year}</span>
                                </>
                              ):<span style={{opacity:0.35,fontSize:10,fontFamily:"'Cinzel',serif"}}>{pos}</span>}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {occPositions.length>0&&(()=>{const occWines=wines.filter(w=>(w.rackSlots||[]).some(s=>s.rackId===rack.id&&(s.positions||[]).length>0));return(
                      <div style={{marginTop:14,display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
                        <span style={{fontSize:15,color:C.textFaint,fontFamily:"'Cinzel', serif",letterSpacing:1}}>LEGENDA:</span>
                        {[...new Set(occWines.map(w=>w.type))].map(type=>{const c=typeColors[type];return(
                          <div key={type} style={{display:"flex",alignItems:"center",gap:6}}>
                            <div style={{width:14,height:14,background:c.badge,border:`1px solid ${c.bar}`,borderRadius:3}}/>
                            <span style={{fontSize:15,color:C.textFaint,fontFamily:"'Cinzel', serif"}}>{type}</span>
                          </div>
                        );})}
                      </div>
                    );})()}
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
          <div style={{ flex:1, overflowY:"auto", minHeight:0 }} {...pullHandlers}><div style={{ padding:"20px 16px", display:"flex", flexDirection:"column", gap:16 }}>
            <PullIndicator />
            <h2 style={{ fontFamily:"'Cinzel', serif", fontSize:18, color:C.gold, letterSpacing:2 }}>COMPOSIZIONE DELLA CANTINA</h2>

            {/* KPI */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(120px,1fr))", gap:10 }}>
              {[
                ["🍾","Bottiglie",totalBt],
                ["🏷","Etichette",wines.length],
                ["🗄","Scaffali",racks.length],
                ["📖","Degustazioni",log.length],
                ["💰","Valore",`€${wines.reduce((s,w)=>s+w.quantity*(parseFloat(w.price)||0),0).toFixed(0)}`],
              ].map(([icon,label,val])=>(
                <div key={label} style={{ background:C.surface, border:`1px solid ${C.border}`,
                  borderRadius:10, padding:"12px 14px", textAlign:"center" }}>
                  <div style={{ fontSize:20, marginBottom:3 }}>{icon}</div>
                  <div style={{ fontSize:22, fontWeight:300, color:C.gold, fontFamily:"'Cinzel',serif" }}>{val}</div>
                  <div style={{ fontSize:11, color:C.textFaint, fontFamily:"'Cinzel',serif", letterSpacing:1, marginTop:2 }}>{label.toUpperCase()}</div>
                </div>
              ))}
            </div>

            <Section title="PER TIPOLOGIA" rows={mkRows(byType)} color={C.gold}/>
            <Section title="PER VITIGNO"   rows={mkRows(byGrape)} color="#7a9aba"/>
            <Section title="PER REGIONE"   rows={mkRows(byRegion)} color="#8aba7a"/>
          </div></div>
        );
      })()}

      {/* ══════ MODAL ADD / EDIT WINE ══════ */}
      {(modal==="add"||modal==="edit") && editing && (
        <div className="modal-overlay" onClick={()=>setModal(null)}>
          <div className="modal-box" onClick={e=>e.stopPropagation()}>
            <div style={{padding:"18px 22px 14px",borderBottom:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:2,background:C.surface,borderRadius:"14px 14px 0 0"}}>
              <h2 style={{fontFamily:"'Cinzel', serif",fontSize:17,color:C.gold,letterSpacing:2}}>{modal==="add"?"AGGIUNGI VINO":"MODIFICA VINO"}</h2>
              <button onClick={()=>setModal(null)} style={{background:"none",border:"none",color:C.textFaint,cursor:"pointer",fontSize:20,lineHeight:1}}>✕</button>
            </div>
            <div style={{padding:"22px 26px",display:"flex",flexDirection:"column",gap:20}}>

              {/* ── SCAN SECTION ── */}
              <div style={{background:C.bg,borderRadius:10,padding:"18px",border:`1px solid ${C.border}`}}>
                <p style={{...labelStyle, marginBottom:12}}>📷 Foto</p>

                {/* Galleria foto esistenti */}
                {(editing.photos||[]).length > 0 && (
                  <div style={{display:"flex",gap:8,marginBottom:14,overflowX:"auto",paddingBottom:4}}>
                    {(editing.photos||[]).map((ph,i) => (
                      <div key={i} style={{flexShrink:0,position:"relative",width:80,height:80,borderRadius:8,overflow:"hidden",border:`1px solid ${C.border}`,background:"#000"}}>
                        <img src={ph} alt={`foto ${i+1}`} onClick={()=>setLightboxPhoto(ph)}
                          style={{width:"100%",height:"100%",objectFit:"cover",cursor:"zoom-in"}}/>
                        {i===0 && (
                          <span style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,0.55)",color:"rgba(255,255,255,0.8)",fontSize:9,textAlign:"center",fontFamily:"'Cinzel',serif",padding:"2px 0"}}>principale</span>
                        )}
                        <button onClick={()=>setEditing(v=>({...v,photos:(v.photos||[]).filter((_,j)=>j!==i)}))}
                          style={{position:"absolute",top:3,right:3,background:"rgba(0,0,0,0.65)",border:"none",color:"#fff",borderRadius:"50%",width:22,height:22,cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Input nascosti */}
                <input ref={scanInputRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
                  onChange={e => { const f=e.target.files?.[0]; if(f) handleScanFile(f); e.target.value=""; }} />
                <input ref={secondPhotoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
                  onChange={e => { const f=e.target.files?.[0]; if(f) handleSecondPhoto(f); e.target.value=""; }} />
                <input ref={addPhotoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
                  onChange={e => { const f=e.target.files?.[0]; if(f) handleAddPhoto(f); e.target.value=""; }} />

                {/* Prompt seconda foto */}
                {firstPhotoData && !scanning ? (
                  <div style={{background:C.surface2,borderRadius:8,padding:"14px 12px",border:`1px solid ${C.border}`}}>
                    <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:12}}>
                      <img src={firstPhotoData.hiResDataUrl} alt="fronte"
                        style={{width:56,height:72,objectFit:"cover",borderRadius:6,border:`1px solid ${C.border}`,flexShrink:0}}/>
                      <div>
                        <p style={{fontFamily:"'Cinzel',serif",fontSize:13,color:C.text,marginBottom:4}}>Foto fronte acquisita.</p>
                        <p style={{fontSize:12,color:C.textMuted}}>Vuoi fotografare anche il retro per un riconoscimento più preciso?</p>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:8}}>
                      <button className="btn-scan" onClick={()=>secondPhotoRef.current?.click()} style={{flex:1}}>
                        <span style={{fontSize:16}}>📷</span><span>Fotografa retro</span>
                      </button>
                      <button className="btn-scan" onClick={handleSkipSecondPhoto} style={{flex:"0 0 auto",padding:"0 14px",fontSize:13}}>
                        Salta →
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{display:"flex",gap:8}}>
                    <button className="btn-scan" disabled={scanning} onClick={()=>scanInputRef.current?.click()} style={{flex:1}}>
                      {scanning ? (
                        <><div className="spinner"/><span>Analisi in corso…</span></>
                      ) : (
                        <><span style={{fontSize:18}}>📷</span><span>{(editing.photos||[]).length>0?"Scansiona di nuovo":"Fotografa etichetta"}</span></>
                      )}
                    </button>
                    <button className="btn-scan" onClick={()=>addPhotoRef.current?.click()} title="Aggiungi altra foto"
                      style={{flex:"0 0 auto",padding:"0 14px",fontSize:18}}>＋</button>
                  </div>
                )}

                {scanning && (
                  <p style={{fontSize:13,color:C.textMuted,marginTop:8,textAlign:"center",fontStyle:"italic"}}>
                    {firstPhotoData ? "Analisi di entrambe le foto…" : "Sto leggendo l'etichetta…"}
                  </p>
                )}
                {scanError && (
                  <p style={{fontSize:13,color:"#c07070",marginTop:8,textAlign:"center"}}>{scanError}</p>
                )}
                {!scanning && !scanError && !firstPhotoData && (
                  <p style={{fontSize:12,color:C.textFaint,marginTop:8,textAlign:"center"}}>
                    Fotografa l'etichetta per compilare automaticamente · usa ＋ per aggiungere altre foto
                  </p>
                )}
              </div>

              {/* ── FORM ── */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:15}}>
                <div style={{gridColumn:"1/-1"}}>
                  <label style={labelStyle}>Nome Vino *</label>
                  <input style={inputStyle} value={editing.name} onChange={e=>setEditing(v=>({...v,name:e.target.value}))} placeholder="es. Adornes"/>
                </div>
                <div style={{gridColumn:"1/-1"}}>
                  <label style={labelStyle}>Denominazione / Tipologia</label>
                  <input style={inputStyle} value={editing.denomination||""} onChange={e=>setEditing(v=>({...v,denomination:e.target.value}))} placeholder="es. Barbera d'Asti Superiore, Barolo DOCG…"/>
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
                  <label style={labelStyle}>Tipologia *</label>
                  <select style={{...inputStyle,color:editing.type?C.text:C.textFaint}} value={editing.type} onChange={e=>setEditing(v=>({...v,type:e.target.value}))}>
                    <option value="">— Seleziona —</option>
                    {WINE_TYPES.map(t=><option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Regione *</label>
                  <select style={{...inputStyle,color:editing.region?C.text:C.textFaint}} value={editing.region} onChange={e=>setEditing(v=>({...v,region:e.target.value}))}>
                    <option value="">— Seleziona —</option>
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

                {/* Shelf picker — multi-rack */}
                <div style={{gridColumn:"1/-1",background:C.bg,borderRadius:9,padding:"16px 18px",border:`1px solid ${C.border}`}}>
                  <p style={{...labelStyle,marginBottom:12}}>🗄 Posizione negli Scaffali</p>
                  {(editing.rackSlots||[]).map((slot,idx)=>{
                    const slotRack=racks.find(r=>r.id===slot.rackId);
                    const isLast=idx===(editing.rackSlots||[]).length-1;
                    return(
                      <div key={idx} style={{marginBottom:isLast?0:14,paddingBottom:isLast?0:14,borderBottom:isLast?"none":`1px solid ${C.border}`}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
                          <select style={{...inputStyle,flex:1}} value={slot.rackId||""} onChange={e=>{
                            const ns=[...(editing.rackSlots||[])];
                            ns[idx]={rackId:e.target.value?parseInt(e.target.value):null,positions:[]};
                            setEditing(v=>({...v,rackSlots:ns}));
                          }}>
                            <option value="">— Scaffale —</option>
                            {racks.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
                          </select>
                          <button onClick={()=>{const ns=(editing.rackSlots||[]).filter((_,i)=>i!==idx);setEditing(v=>({...v,rackSlots:ns}));}}
                            style={{flexShrink:0,background:"none",border:`1px solid #804040`,borderRadius:6,color:"#c07070",cursor:"pointer",padding:"8px 11px",fontSize:15,lineHeight:1}}>✕</button>
                        </div>
                        {slotRack&&(
                          <PositionGrid rack={slotRack} values={slot.positions||[]} maxSelections={editing.quantity||1}
                            onChange={ps=>{const ns=[...(editing.rackSlots||[])];ns[idx]={...ns[idx],positions:ps};setEditing(v=>({...v,rackSlots:ns}));}}/>
                        )}
                      </div>
                    );
                  })}
                  {racks.length>0&&(
                    <button onClick={()=>setEditing(v=>({...v,rackSlots:[...(v.rackSlots||[]),{rackId:null,positions:[]}]}))}
                      style={{marginTop:(editing.rackSlots||[]).length>0?12:0,background:"none",border:`1px dashed ${C.border}`,borderRadius:7,color:C.textFaint,cursor:"pointer",padding:"8px 14px",fontFamily:"'Cinzel',serif",fontSize:13,letterSpacing:1,width:"100%",transition:"all 0.15s"}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textFaint;}}>
                      + Aggiungi scaffale
                    </button>
                  )}
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

              {/* Galleria foto — hero se una sola, strip se multiple */}
              {(editing.photos||[]).length > 0 && (
                (editing.photos||[]).length === 1 ? (
                  /* Hero singola */
                  <div style={{height:180,overflow:"hidden",position:"relative",display:"flex",alignItems:"center",justifyContent:"center",background:"#1a0f08"}}>
                    <img src={editing.photos[0]} alt={editing.name} onClick={()=>setLightboxPhoto(editing.photos[0])}
                      style={{maxHeight:"100%",maxWidth:"100%",objectFit:"contain",cursor:"zoom-in"}}/>
                    <div style={{position:"absolute",inset:0,background:"linear-gradient(to bottom, transparent 40%, rgba(62,42,22,0.9) 100%)",pointerEvents:"none"}}/>
                    <div style={{position:"absolute",bottom:10,left:0,right:0,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"0 12px"}}>
                      <button onClick={()=>{
                        const updated={...editing,photos:[]};
                        saveWines(wines.map(w=>w.id===editing.id?updated:w));
                        setEditing(updated);showToast("Foto rimossa");
                      }} style={{background:"rgba(0,0,0,0.55)",border:"1px solid rgba(255,255,255,0.2)",borderRadius:6,color:"rgba(255,255,255,0.7)",cursor:"pointer",padding:"4px 10px",fontSize:12,fontFamily:"'Cinzel',serif",backdropFilter:"blur(4px)"}}>✕ rimuovi</button>
                      <span style={{fontSize:11,color:"rgba(255,255,255,0.5)",fontFamily:"'Cinzel',serif",letterSpacing:1}}>🔍 tocca per ingrandire</span>
                    </div>
                  </div>
                ) : (
                  /* Strip orizzontale per più foto */
                  <div style={{display:"flex",gap:0,overflowX:"auto",background:"#1a0f08",borderBottom:`1px solid ${C.border}`}}>
                    {(editing.photos||[]).map((ph,i) => (
                      <div key={i} style={{flexShrink:0,position:"relative",height:160,width:120}}>
                        <img src={ph} alt={`foto ${i+1}`} onClick={()=>setLightboxPhoto(ph)}
                          style={{width:"100%",height:"100%",objectFit:"cover",cursor:"zoom-in",display:"block"}}/>
                        <button onClick={()=>{
                          const newPhotos=(editing.photos||[]).filter((_,j)=>j!==i);
                          const updated={...editing,photos:newPhotos};
                          saveWines(wines.map(w=>w.id===editing.id?updated:w));
                          setEditing(updated);
                        }} style={{position:"absolute",top:6,right:6,background:"rgba(0,0,0,0.65)",border:"none",color:"#fff",borderRadius:"50%",width:24,height:24,cursor:"pointer",fontSize:13,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
                        {i===0&&<span style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(0,0,0,0.55)",color:"rgba(255,255,255,0.7)",fontSize:10,textAlign:"center",fontFamily:"'Cinzel',serif",padding:"3px 0"}}>principale</span>}
                      </div>
                    ))}
                  </div>
                )
              )}

              <div style={{padding:"20px 22px"}}>
                {/* Anno */}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,marginTop:(editing.photos||[]).length>0?4:0}}>
                  <TypeBadge type={editing.type}/>
                  <span style={{fontSize:38,fontWeight:300,color:C.gold,fontFamily:"'Cinzel', serif",letterSpacing:2}}>{editing.year}</span>
                </div>

                {/* Nome + denominazione */}
                <h2 style={{fontFamily:"'Cinzel', serif",fontSize:42,fontWeight:700,color:C.text,margin:"0 0 6px",lineHeight:1.1}}>{editing.name}</h2>
                {editing.denomination && (
                  <p style={{fontFamily:"'Cinzel', serif",fontSize:22,color:C.textMuted,margin:"0 0 6px",fontWeight:400}}>{editing.denomination}</p>
                )}

                {/* Produttore */}
                <p style={{fontFamily:"'Cinzel', serif",fontSize:26,color:C.textMuted,margin:"0 0 18px"}}>{editing.producer}</p>

                {/* Info pill */}
                <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:16}}>
                  {[
                    ["📍", editing.region],
                    ["🍇", editing.grape||null],
                    ["🍾", `${editing.quantity} bt`],
                    ...(editing.price?[["💰", `€${editing.price}`]]:[]),
                  ].filter(([,v])=>v).map(([icon,val])=>(
                    <span key={icon+val} style={{
                      display:"inline-flex", alignItems:"center", gap:5,
                      background:C.bg, border:`1px solid ${C.border}`,
                      borderRadius:20, padding:"7px 16px",
                      fontSize:17, color:C.text, fontFamily:"'Cinzel', serif",
                    }}>
                      <span>{icon}</span><span>{val}</span>
                    </span>
                  ))}
                  {(editing.rackSlots||[]).filter(s=>(s.positions||[]).length>0).map(slot=>{
                    const sr=racks.find(r=>r.id===slot.rackId);
                    if(!sr) return null;
                    return(
                      <span key={slot.rackId} style={{
                        display:"inline-flex", alignItems:"center", gap:5,
                        background:"rgba(201,149,58,0.12)", border:`1px solid rgba(201,149,58,0.35)`,
                        borderRadius:20, padding:"7px 16px",
                        fontSize:17, color:C.gold, fontFamily:"'Cinzel', serif", fontWeight:700,
                      }}>
                        📌 {sr.name}: {(slot.positions||[]).join(" · ")}
                      </span>
                    );
                  })}
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
                            <div style={{fontSize:20, color:ag.c, fontFamily:"'Cinzel', serif", fontWeight:700, letterSpacing:1}}>{ag.s}</div>
                            <div style={{fontSize:16, color:C.textMuted, fontFamily:"'Cinzel', serif"}}>{age} {age===1?"anno":"anni"} · {editing.type}</div>
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
                        <p style={{fontSize:18, color:C.textMuted, fontFamily:"Georgia, 'Times New Roman', serif", lineHeight:1.6, margin:0, fontWeight:400}}>
                          {agingNote}
                        </p>
                      )}
                    </div>
                  );
                })()}

                {(editing.rackSlots||[]).filter(s=>(s.positions||[]).length>0).map(slot=>{
                  const sr=racks.find(r=>r.id===slot.rackId);
                  if(!sr) return null;
                  return(
                    <div key={slot.rackId} style={{background:C.bg,borderRadius:9,padding:"10px 12px",marginBottom:10,border:`1px solid ${C.border}`}}>
                      <div style={{fontSize:12,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:8}}>POSIZIONE — {sr.name}</div>
                      <MiniRackMap rack={sr} highlightPositions={slot.positions||[]}/>
                    </div>
                  );
                })}

                {editing.notes&&(
                  <div style={{background:C.bg,borderRadius:8,padding:"10px 14px",marginBottom:10}}>
                    <div style={{fontSize:13,color:C.textFaint,letterSpacing:1.2,fontFamily:"'Cinzel', serif",marginBottom:6}}>NOTE DI DEGUSTAZIONE</div>
                    <p style={{fontSize:18,color:C.textMuted,lineHeight:1.6,fontFamily:"Georgia, 'Times New Roman', serif",fontWeight:400}}>{editing.notes}</p>
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
                              <p style={{fontSize:17,color:C.textMuted,lineHeight:1.7,fontFamily:"Georgia, 'Times New Roman', serif",margin:0}}>
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
                  <button onClick={()=>{setModal(null);setDeleteConfirm({wine:editing,fromPos:viewFromPos});setViewFromPos(null);}} title="Elimina"
                    style={{flex:"0 0 auto",background:"transparent",border:`1px solid #804040`,borderRadius:8,
                      color:"#c07070",cursor:"pointer",padding:"11px 13px",fontSize:18,lineHeight:1,
                      transition:"background 0.15s",}}
                    onMouseEnter={e=>e.currentTarget.style.background="rgba(180,60,60,0.15)"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                  >🗑</button>
                  {/* DEGUSTA */}
                  {editing.quantity > 0 && (
                    <button onClick={()=>handleDrinkOne(editing)} title="Degusta una bottiglia"
                      style={{flex:"1 1 0",background:"linear-gradient(135deg, #3a1a5a, #7a3a9a)",
                        color:"#f0d0ff",border:"none",borderRadius:8,padding:"11px 8px",cursor:"pointer",
                        fontFamily:"'Cinzel', serif",fontSize:13,letterSpacing:1,fontWeight:700,
                        whiteSpace:"nowrap",textAlign:"center",
                      }}>🍷 DEGUSTA</button>
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
      {deleteConfirm&&(()=>{
        const {wine:dw, fromPos} = deleteConfirm;
        const multiBottle = dw.quantity > 1;
        const removeOne = () => {
          const newSlots = fromPos
            ? (dw.rackSlots||[]).map(s=>({...s,positions:(s.positions||[]).filter(p=>p!==fromPos)}))
            : (dw.rackSlots||[]).map((s,i,arr)=>{
                const last=[...arr].reverse().findIndex(x=>(x.positions||[]).length>0);
                const idx=arr.length-1-last;
                return i===idx?{...s,positions:s.positions.slice(0,-1)}:s;
              });
          const updated={...dw,quantity:dw.quantity-1,rackSlots:newSlots};
          saveWines(wines.map(w=>w.id===dw.id?updated:w));
          setDeleteConfirm(null);
          showUndoToast(`Una bottiglia rimossa`, ()=>saveWines(wines.map(w=>w.id===dw.id?dw:w)));
        };
        const removeAll = () => {
          const prev=wines;
          saveWines(wines.filter(w=>w.id!==dw.id));
          setDeleteConfirm(null);
          showUndoToast(`"${dw.name}" rimosso`, ()=>saveWines(prev));
        };
        return(
          <div className="modal-overlay" onClick={()=>setDeleteConfirm(null)}>
            <div className="modal-box" style={{maxWidth:380}} onClick={e=>e.stopPropagation()}>
              <div style={{padding:"30px",textAlign:"center"}}>
                <div style={{fontSize:36,marginBottom:14}}>🗑</div>
                <h3 style={{fontFamily:"'Cinzel', serif",color:C.text,marginBottom:12,fontSize:18,letterSpacing:1}}>RIMUOVI VINO</h3>
                <p style={{color:C.textMuted,marginBottom:6,fontSize:18}}><strong style={{color:C.gold}}>{dw.name}</strong></p>
                {multiBottle && <p style={{color:C.textFaint,marginBottom:20,fontSize:14}}>Hai {dw.quantity} bottiglie. Vuoi rimuoverne una sola o eliminare tutta l'etichetta?</p>}
                {!multiBottle && <p style={{color:C.textFaint,marginBottom:20,fontSize:14}}>Questa è l'ultima bottiglia. Vuoi eliminare l'etichetta?</p>}
                <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
                  <button className="btn-ghost" onClick={()=>setDeleteConfirm(null)}>ANNULLA</button>
                  {multiBottle && (
                    <button className="btn-gold" style={{background:"linear-gradient(135deg,#5a3000,#a05020)"}} onClick={removeOne}>
                      RIMUOVI 1 BOTTIGLIA
                    </button>
                  )}
                  <button className="btn-gold" style={{background:"linear-gradient(135deg,#7a2020,#c04040)"}} onClick={removeAll}>
                    ELIMINA ETICHETTA
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

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
        const slotsWithPos = (wine.rackSlots||[]).filter(s => (s.positions||[]).length > 0);
        const hasPositions = slotsWithPos.length > 0;
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

                {hasPositions ? slotsWithPos.map(slot => {
                  const rack = racks.find(r => r.id === slot.rackId);
                  if (!rack) return null;
                  const positions = slot.positions || [];
                  return (
                    <div key={slot.rackId} style={{marginBottom:16}}>
                      <p style={{ fontSize: 15, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginBottom: 10 }}>
                        SELEZIONA LA CELLA DA SVUOTARE — {rack.name}
                      </p>
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
                            const otherWine = !isThis && wines.find(w => (w.rackSlots||[]).some(s => s.rackId === rack.id && (s.positions||[]).includes(pos)));
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
                    </div>
                  );
                }) : (
                  <p style={{ fontSize: 17, color: C.textMuted, fontFamily: "'EB Garamond', serif", marginBottom: 20 }}>
                    Nessuna posizione assegnata. Verrà decrementata la quantità.
                  </p>
                )}
                {hasPositions && <p style={{ fontSize: 14, color: C.textFaint, fontStyle: "italic", marginTop: 4 }}>Le celle viola sono le tue bottiglie. Clicca su quella che stai prelevando.</p>}

                <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 20 }}>
                  <button className="btn-ghost" onClick={() => setDrinkModal(null)}>ANNULLA</button>
                  {!hasPositions && (
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
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px" }} {...pullHandlers}>
          <PullIndicator />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, letterSpacing: 2 }}>STORICO DEGUSTAZIONI</h2>
            <span style={{ fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{log.length} {log.length===1?"bottiglia":"bottiglie"}</span>
          </div>
          {/* Search bar */}
          <div style={{ position: "relative", marginBottom: 16 }}>
            <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: C.textFaint, fontSize: 15 }}>🔍</span>
            <input placeholder="Cerca per vino, produttore, note, occasione…"
              value={logSearch} onChange={e => setLogSearch(e.target.value)}
              style={{ ...inputStyle, paddingLeft: 38, paddingRight: logSearch ? 36 : 14 }} />
            {logSearch && (
              <button onClick={() => setLogSearch("")} style={{
                position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                background: C.border, border: "none", borderRadius: "50%",
                width: 22, height: 22, cursor: "pointer", color: C.text,
                fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center",
              }}>✕</button>
            )}
          </div>
          {log.length === 0 ? (
            <div style={{ textAlign: "center", padding: "60px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.4 }}>🍷</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 14 }}>NESSUNA BOTTIGLIA REGISTRATA</p>
              <p style={{ fontSize: 15, color: C.textFaint, marginTop: 8, fontStyle: "italic" }}>Le bottiglie bevute appariranno qui dopo averle registrate.</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {[...log]
                .filter(entry => {
                  if (!logSearch) return true;
                  const q = logSearch.toLowerCase();
                  return [
                    entry.wineName, entry.wineProducer, entry.wineGrape,
                    entry.wineRegion, entry.occasion, entry.companions,
                    entry.notes, entry.olfatto_descrizione,
                    entry.gusto_corpo, entry.gusto_equilibrio, entry.gusto_persistenza,
                    entry.gusto_acidita, entry.gusto_tannini, entry.vista_colore,
                    entry.olfatto_intensita, entry.olfatto_qualita,
                    entry.wineYear ? String(entry.wineYear) : "",
                    entry.wineType,
                  ].some(f => f?.toLowerCase().includes(q));
                })
                .sort((a,b) => b.date.localeCompare(a.date)).map(entry => (
                <div key={entry.id}
                  onClick={() => { setLogEntry(entry); setLogModal("edit"); }}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", cursor: "pointer", display: "flex", gap: 0 }}
                  className="wine-card">
                  {((entry.winePhotos||[])[0] || entry.winePhoto) && (
                    <div style={{ width: 72, flexShrink: 0, overflow: "hidden", background: "#000" }}>
                      <img src={(entry.winePhotos||[])[0] || entry.winePhoto} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} alt={entry.wineName} />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0, padding: "12px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                      <div>
                        <h3 style={{ fontFamily: "'Cinzel', serif", fontSize: 17, color: C.text, marginBottom: 2 }}>
                          🍇 {entry.wineName}
                        </h3>
                        <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic" }}>{entry.wineProducer}{entry.wineYear ? ` · ${entry.wineYear}` : ""}</p>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>
                          {new Date(entry.date).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
                        </div>
                        {entry.rating > 0 && (
                          <div style={{ marginTop: 3, fontFamily: "'Cinzel', serif", fontSize: 13, color: C.gold }}>
                            {entry.rating}/100
                          </div>
                        )}
                      </div>
                    </div>
                    {/* Contesto */}
                    <div style={{ display: "flex", gap: 12, fontSize: 13, color: C.textFaint, fontFamily: "'EB Garamond', serif", flexWrap: "wrap", marginBottom: 4 }}>
                      {entry.occasion && <span>📅 {entry.occasion}</span>}
                      {entry.companions && <span>👥 {entry.companions}</span>}
                    </div>
                    {entry.notes && <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic", lineHeight: 1.5, margin: 0 }}>"{entry.notes}"</p>}
                  </div>
                  <button onClick={e => { e.stopPropagation(); const removed = entry; saveLog(log.filter(l => l.id !== entry.id)); showUndoToast("Voce eliminata", () => saveLog([removed, ...log.filter(l => l.id !== removed.id)])); }}
                    style={{ alignSelf: "stretch", background: "none", border: "none", borderLeft: `1px solid ${C.bg}`, padding: "0 12px", cursor: "pointer", color: "#7a4040", fontSize: 16, transition: "color 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.color="#d07070"}
                    onMouseLeave={e => e.currentTarget.style.color="#7a4040"}
                  >✕</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 24, textAlign: "center" }}>
            <span style={{ fontSize: 11, color: C.textFaint, fontFamily: "monospace", letterSpacing: 1 }}>{__APP_VERSION__}</span>
          </div>
        </div>
      )}

      {/* ── LOG MODAL ── */}
      {(logModal === "add" || logModal === "edit") && logEntry && (
        <div className="modal-overlay" onClick={() => setLogModal(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div style={{ position:"sticky", top:0, zIndex:2, background:C.surface, borderBottom: `1px solid ${C.border}`, borderRadius:"14px 14px 0 0" }}>
              {/* Foto vino (strip) */}
              {(logEntry.winePhotos||[]).length > 0 && (
                <div style={{ display:"flex", overflowX:"auto", background:"#1a0f08", maxHeight:100 }}>
                  {(logEntry.winePhotos||[]).map((ph,i) => (
                    <img key={i} src={ph} alt="" onClick={()=>setLightboxPhoto(ph)}
                      style={{ height:100, width:"auto", objectFit:"cover", cursor:"zoom-in", flexShrink:0 }} />
                  ))}
                </div>
              )}
              <div style={{ padding: "14px 20px 12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:11, color:C.gold, fontFamily:"'Cinzel',serif", letterSpacing:2, marginBottom:4 }}>
                    {logModal === "add" ? "🍷 REGISTRA DEGUSTAZIONE" : "✏ MODIFICA VOCE"}
                  </div>
                  <div style={{ fontFamily:"'Cinzel',serif", fontSize:20, fontWeight:700, color:C.text, lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{logEntry.wineName}</div>
                  <div style={{ display:"flex", gap:8, marginTop:4, flexWrap:"wrap" }}>
                    {logEntry.wineYear && <span style={{ fontFamily:"'Cinzel',serif", fontSize:16, color:C.gold, fontWeight:300 }}>{logEntry.wineYear}</span>}
                    {logEntry.wineType && <span style={{ fontFamily:"'Cinzel',serif", fontSize:14, color:C.textMuted }}>{logEntry.wineType}</span>}
                    {logEntry.wineProducer && <span style={{ fontFamily:"'Cinzel',serif", fontSize:14, color:C.textMuted }}>· {logEntry.wineProducer}</span>}
                  </div>
                </div>
                <button onClick={() => setLogModal(null)} style={{ background: "none", border: "none", color: C.textFaint, cursor: "pointer", fontSize: 20, flexShrink:0, paddingLeft:12 }}>✕</button>
              </div>
            </div>
            <div style={{ padding: "16px 22px", display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Contesto */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={labelStyle}>Data</label>
                  <input type="date" style={inputStyle} value={logEntry.date}
                    onChange={e => setLogEntry(v => ({ ...v, date: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Occasione</label>
                  <input style={inputStyle} value={logEntry.occasion}
                    onChange={e => setLogEntry(v => ({ ...v, occasion: e.target.value }))}
                    placeholder="Cena, Ristorante, Degustazione…" />
                </div>
                <div>
                  <label style={labelStyle}>Con chi</label>
                  <input style={inputStyle} value={logEntry.companions}
                    onChange={e => setLogEntry(v => ({ ...v, companions: e.target.value }))}
                    placeholder="Famiglia, Amici, Da solo…" />
                </div>
              </div>

              {/* Foto degustazione */}
              <div style={{ background:C.bg, borderRadius:9, padding:"12px 14px", border:`1px solid ${C.border}` }}>
                <p style={{ ...labelStyle, marginBottom:10, color:C.gold }}>📷 FOTO DEGUSTAZIONE</p>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", alignItems:"flex-start" }}>
                  {(logEntry.tastingPhotos||[]).map((ph,i) => (
                    <div key={i} style={{ position:"relative", width:72, height:72, borderRadius:7, overflow:"hidden", border:`1px solid ${C.border}` }}>
                      <img src={ph} alt="" onClick={()=>setLightboxPhoto(ph)}
                        style={{ width:"100%", height:"100%", objectFit:"cover", cursor:"zoom-in" }} />
                      <button onClick={()=>setLogEntry(v=>({...v,tastingPhotos:(v.tastingPhotos||[]).filter((_,j)=>j!==i)}))}
                        style={{ position:"absolute", top:3, right:3, background:"rgba(0,0,0,0.65)", border:"none", color:"#fff", borderRadius:"50%", width:20, height:20, cursor:"pointer", fontSize:11, display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                    </div>
                  ))}
                  <input ref={tastingPhotoRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }}
                    onChange={async e => {
                      const f = e.target.files?.[0]; if (!f) return;
                      const dataUrl = await resizeImage(f, 1800, 0.93);
                      setLogEntry(v => ({ ...v, tastingPhotos: [...(v.tastingPhotos||[]), dataUrl] }));
                      e.target.value = "";
                    }} />
                  <button onClick={()=>tastingPhotoRef.current?.click()}
                    style={{ width:72, height:72, borderRadius:7, border:`2px dashed ${C.border}`, background:"transparent", color:C.textFaint, cursor:"pointer", fontSize:24, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                    +
                  </button>
                </div>
              </div>

              {/* AIS — ESAME VISIVO */}
              {(()=>{
                const sectionStyle = { background: C.bg, borderRadius: 9, padding: "12px 14px", border: `1px solid ${C.border}` };
                const rowStyle = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 };
                const sel = (field, opts) => (
                  <select style={{ ...inputStyle, fontSize: 15, padding: "7px 10px" }}
                    value={logEntry[field]||""}
                    onChange={e => setLogEntry(v => ({ ...v, [field]: e.target.value }))}>
                    <option value="">—</option>
                    {opts.map(o => <option key={o}>{o}</option>)}
                  </select>
                );
                return (<>
                  <div style={sectionStyle}>
                    <p style={{ ...labelStyle, marginBottom: 0, color: C.gold }}>👁 ESAME VISIVO</p>
                    <div style={rowStyle}>
                      <div>
                        <label style={labelStyle}>Limpidezza</label>
                        {sel("vista_limpidezza", ["Limpido","Abbastanza limpido","Velato","Torbido"])}
                      </div>
                      <div>
                        <label style={labelStyle}>Colore</label>
                        {sel("vista_colore", logEntry.wineType === "Bianco"
                          ? ["Giallo verdolino","Giallo paglierino","Giallo dorato","Giallo ambrato"]
                          : logEntry.wineType === "Rosato"
                          ? ["Rosa tenue","Rosa cerasuolo","Rosa chiaretto"]
                          : logEntry.wineType === "Spumante"
                          ? ["Bianco","Giallo paglierino","Giallo dorato","Rosato"]
                          : ["Rosso porpora","Rosso rubino","Rosso granato","Rosso aranciato"]
                        )}
                      </div>
                      <div>
                        <label style={labelStyle}>Intensità colore</label>
                        {sel("vista_intensita_colore", ["Tenue","Poco intenso","Abbastanza intenso","Intenso","Molto intenso"])}
                      </div>
                    </div>
                  </div>

                  <div style={sectionStyle}>
                    <p style={{ ...labelStyle, marginBottom: 0, color: C.gold }}>👃 ESAME OLFATTIVO</p>
                    <div style={rowStyle}>
                      <div>
                        <label style={labelStyle}>Intensità</label>
                        {sel("olfatto_intensita", ["Carente","Poco intenso","Abbastanza intenso","Intenso","Molto intenso"])}
                      </div>
                      <div>
                        <label style={labelStyle}>Qualità</label>
                        {sel("olfatto_qualita", ["Comune","Poco fine","Abbastanza fine","Fine","Eccellente"])}
                      </div>
                    </div>
                    <div style={{ marginTop: 10 }}>
                      <label style={labelStyle}>Descrizione aromi</label>
                      <input style={{ ...inputStyle, fontSize: 15, padding: "7px 10px" }}
                        value={logEntry.olfatto_descrizione||""}
                        onChange={e => setLogEntry(v => ({ ...v, olfatto_descrizione: e.target.value }))}
                        placeholder="es. Frutti rossi, spezie, vaniglia, tabacco…" />
                    </div>
                  </div>

                  <div style={sectionStyle}>
                    <p style={{ ...labelStyle, marginBottom: 0, color: C.gold }}>👅 ESAME GUSTATIVO</p>
                    <div style={rowStyle}>
                      <div>
                        <label style={labelStyle}>Corpo</label>
                        {sel("gusto_corpo", ["Leggero","Di medio corpo","Abbastanza strutturato","Strutturato","Molto strutturato"])}
                      </div>
                      <div>
                        <label style={labelStyle}>Acidità</label>
                        {sel("gusto_acidita", ["Piatto","Poco acido","Abbastanza fresco","Fresco","Molto fresco"])}
                      </div>
                      {(logEntry.wineType === "Rosso" || logEntry.wineType === "Passito") && (
                        <div>
                          <label style={labelStyle}>Tannini</label>
                          {sel("gusto_tannini", ["Molli","Poco tannico","Abbastanza tannico","Tannico","Molto tannico"])}
                        </div>
                      )}
                      <div>
                        <label style={labelStyle}>Persistenza</label>
                        {sel("gusto_persistenza", ["Corto","Poco persistente","Abbastanza persistente","Persistente","Molto persistente"])}
                      </div>
                      <div>
                        <label style={labelStyle}>Equilibrio</label>
                        {sel("gusto_equilibrio", ["Non equilibrato","Poco equilibrato","Abbastanza equilibrato","Equilibrato","Molto equilibrato"])}
                      </div>
                    </div>
                  </div>

                  {/* Valutazione globale */}
                  <div style={sectionStyle}>
                    <p style={{ ...labelStyle, marginBottom: 8, color: C.gold }}>PUNTEGGIO AIS</p>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                      <input type="range" min={0} max={100} step={1}
                        value={logEntry.rating||0}
                        onChange={e => setLogEntry(v => ({ ...v, rating: parseInt(e.target.value) }))}
                        style={{ flex: 1, accentColor: C.gold }} />
                      <span style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, minWidth: 48, textAlign: "right" }}>
                        {logEntry.rating||0}/100
                      </span>
                    </div>
                    <div>
                      <label style={labelStyle}>Note finali</label>
                      <textarea style={{ ...inputStyle, minHeight: 70, resize: "vertical", lineHeight: 1.6 }}
                        value={logEntry.notes||""}
                        onChange={e => setLogEntry(v => ({ ...v, notes: e.target.value }))}
                        placeholder="Impressioni generali, abbinamento cibo, momenti memorabili…" />
                    </div>
                  </div>
                </>);
              })()}

              {/* ── ANALISI DEL VINO (salvata dalla scheda) ── */}
              {logEntry.wineEnrichment && (() => {
                const d = logEntry.wineEnrichment;
                return (
                  <div style={{ background: C.bg, borderRadius: 9, padding: "12px 14px", border: `1px solid ${C.border}` }}>
                    <div style={{ fontSize: 13, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginBottom: 10, fontWeight: 700 }}>ANALISI DEL VINO</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {[
                        ["🍇 Il Vitigno", d.grapeProfile],
                        ["👃 Sentori & Degustazione", d.tastingNotes],
                        ["🌍 Territorio", d.territory],
                        ["⏳ Invecchiamento", d.aging],
                        ["🍽 Abbinamenti", d.foodPairing],
                        ["💡 Lo sapevi?", d.curiosity],
                      ].filter(([, v]) => v).map(([label, text]) => (
                        <div key={label}>
                          <div style={{ fontSize: 12, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginBottom: 2 }}>{label}</div>
                          <p style={{ fontSize: 15, color: C.textMuted, lineHeight: 1.6, fontFamily: "'EB Garamond', serif", margin: 0 }}>{text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div style={{ position: "sticky", bottom: 0, background: C.surface,
                borderTop: `1px solid ${C.border}`, padding: "12px 0 4px",
                display: "flex", gap: 10, justifyContent: "flex-end",
                paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
                <button className="btn-ghost" onClick={() => {
                  // Se si salta, aggiorna comunque la cantina
                  if (logModal !== "edit" && pendingDrink) {
                    const { wine, newQty, newSlots } = pendingDrink;
                    if (newQty <= 0) {
                      saveWines(wines.filter(w => w.id !== wine.id));
                      setEditing(null); setModal(null);
                    } else {
                      const updated = { ...wine, quantity: newQty, rackSlots: newSlots };
                      saveWines(wines.map(w => w.id === wine.id ? updated : w));
                      setEditing(updated);
                    }
                    setPendingDrink(null);
                  }
                  setLogModal(null);
                }}>{logModal === "edit" ? "ANNULLA" : "SALTA"}</button>
                {logModal === "edit" && (
                  <button className="btn-danger" onClick={() => {
                    const removed = logEntry;
                    saveLog(log.filter(l => l.id !== logEntry.id));
                    setLogModal(null);
                    showUndoToast("Voce eliminata", () => saveLog([removed, ...log.filter(l => l.id !== removed.id)]));
                  }}>ELIMINA</button>
                )}
                <button className="btn-gold" onClick={() => {
                  if (logModal === "edit") {
                    saveLog(log.map(l => l.id === logEntry.id ? logEntry : l));
                    showToast("✏ Voce aggiornata");
                  } else {
                    saveLog([logEntry, ...log]);
                    // Applica la modifica alla cantina ora che è confermato
                    if (pendingDrink) {
                      const { wine, newQty, newSlots } = pendingDrink;
                      if (newQty <= 0) {
                        saveWines(wines.filter(w => w.id !== wine.id));
                        setEditing(null); setModal(null);
                      } else {
                        const updated = { ...wine, quantity: newQty, rackSlots: newSlots };
                        saveWines(wines.map(w => w.id === wine.id ? updated : w));
                        setEditing(updated);
                      }
                      setPendingDrink(null);
                    }
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
        <div style={{position:"fixed",bottom:26,left:"50%",transform:"translateX(-50%)",background:C.surface,border:`1px solid ${C.border}`,borderRadius:9,padding:"13px 20px",color:C.gold,fontFamily:"'Cinzel', serif",fontSize:15,letterSpacing:1,boxShadow:"0 8px 24px rgba(0,0,0,0.4)",zIndex:300,animation:"fadeUp 0.2s ease",display:"flex",alignItems:"center",gap:16,whiteSpace:"nowrap"}}>
          <span>{toast}</span>
          {undoState && (
            <button onClick={() => {
              clearTimeout(undoState.timer);
              undoState.restore();
              setToast(null); setUndoState(null);
              showToast("✓ Ripristinato");
            }} style={{background:"none",border:`1px solid ${C.gold}`,borderRadius:6,color:C.gold,cursor:"pointer",padding:"4px 12px",fontFamily:"'Cinzel', serif",fontSize:13,letterSpacing:1}}>
              ANNULLA
            </button>
          )}
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
      {/* ── FAB AGGIUNGI VINO ── */}
      {!modal && !rackModal && (view === "catalog" || view === "racks") && <button
        onClick={() => {
          if (view === "racks") { setEditingRack(emptyRack()); setRackModal("add"); }
          else { setEditing(emptyWine()); setScanError(null); setModal("add"); }
        }}
        title="Aggiungi vino"
        style={{
          position: "fixed", bottom: 28, right: 24, zIndex: 300,
          width: 56, height: 56, borderRadius: "50%",
          background: "linear-gradient(135deg, #c9953a, #a06820)",
          border: "none", color: "#fff",
          fontSize: 30, lineHeight: 1,
          boxShadow: "0 4px 18px rgba(0,0,0,0.5)",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >+</button>}
    </div>
  );
}
