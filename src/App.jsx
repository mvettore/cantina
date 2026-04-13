import { useState, useRef, useEffect, useCallback } from "react";

// Riduce il font-size finché il testo sta su una riga senza overflow
function FitText({ text, maxSize = 20, minSize = 12, style }) {
  const ref = useRef(null);
  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    let s = maxSize;
    el.style.fontSize = s + "px";
    while (el.scrollWidth > el.offsetWidth && s > minSize) {
      s -= 0.5;
      el.style.fontSize = s + "px";
    }
  }, [text, maxSize, minSize]);
  useEffect(() => {
    fit();
    const ro = new ResizeObserver(fit);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [fit]);
  return (
    <span ref={ref} style={{ ...style, fontSize: maxSize, whiteSpace: "nowrap", overflow: "hidden", display: "block" }}>
      {text}
    </span>
  );
}

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
// Stato iniziale vuoto: se il cloud sync fallisce, l'utente vede una cantina vuota
// (segnale chiaro che c'è un problema) invece di finti dati demo che potrebbero
// essere inavvertitamente pushati su Supabase sovrascrivendo la cantina reale.
const INITIAL_WINES = [];

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
function saveLocal(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {
    try { localStorage.removeItem("cantina-wines-backup-v1"); } catch {}
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
}

// ── Foto separate: ogni vino ha la propria chiave, indipendente dai metadati ──
// ── Foto: helpers per distinguere URL (Supabase Storage) da base64 legacy ──
const PHOTO_KEY_PREFIX = "cantina-photo-";
const isPhotoURL = (p) => typeof p === "string" && (p.startsWith("http://") || p.startsWith("https://"));
const isPhotoBase64 = (p) => typeof p === "string" && p.startsWith("data:");

// Carica foto legacy dalle chiavi localStorage separate (cantina-photo-{id}) SOLO
// se il vino non ha già foto nel suo array. Questo preserva i nuovi URL Supabase
// senza reintrodurre base64 legacy.
function loadWinePhotos(wines) {
  return wines.map(wine => {
    if ((wine.photos || []).length > 0) return wine; // già con foto (URL o base64 recente)
    try {
      const raw = localStorage.getItem(PHOTO_KEY_PREFIX + wine.id);
      if (raw) return { ...wine, photos: JSON.parse(raw) };
    } catch {}
    return wine;
  });
}
function loadWinesLocal(fallback) {
  return loadWinePhotos(loadLocal(STORAGE_KEY, fallback));
}

// Upload di una foto su Supabase Storage tramite function proxy.
// Accetta sia un data URL base64 completo che base64 puro.
// Ritorna l'URL pubblico da salvare in wine.photos[].
async function uploadPhotoToStorage(wineId, index, base64DataUrl) {
  const parts = base64DataUrl.split(",");
  const base64 = parts.length > 1 ? parts[1] : base64DataUrl;
  let mediaType = "image/jpeg";
  if (parts.length > 1) {
    const m = parts[0].match(/^data:([^;]+);/);
    if (m) mediaType = m[1];
  }
  const resp = await fetch("/.netlify/functions/upload-photo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wineId, index, base64, mediaType }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Upload HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.url;
}

// ── Backup automatico degli ultimi 5 snapshot vini ──
const BACKUP_KEY = "cantina-wines-backup-v1";
const BACKUP_MAX = 5;
function saveWinesBackup(wines) {
  try {
    const snapshots = loadLocal(BACKUP_KEY, []);
    // Escludi le foto dal backup: occupano troppo spazio (base64) e riempiono il localStorage
    const winesNoPhotos = wines.map(({ photos: _, ...w }) => w);
    snapshots.push({ ts: new Date().toISOString(), count: wines.length, wines: winesNoPhotos });
    if (snapshots.length > BACKUP_MAX) snapshots.splice(0, snapshots.length - BACKUP_MAX);
    localStorage.setItem(BACKUP_KEY, JSON.stringify(snapshots));
  } catch {}
}

// ── Merge vini: last-write-wins su lastModified, cloud aggiunge nuovi vini ──
// Le foto vengono sempre preservate dal dispositivo che le ha, indipendentemente
// da chi "vince" sugli altri campi (es. Mac aggiorna quantità ma non ha foto).
function mergeWines(localWines, cloudWines) {
  const cloudMap = new Map(cloudWines.map(w => [w.id, w]));
  const merged = localWines.map(lw => {
    const cw = cloudMap.get(lw.id);
    if (!cw) return lw;
    const winner = (cw.lastModified || 0) > (lw.lastModified || 0) ? cw : lw;
    const loser  = winner === cw ? lw : cw;
    // Foto: usa quelle del winner se ne ha, altrimenti quelle del loser
    const photos = (winner.photos?.length > 0) ? winner.photos : (loser.photos || []);
    return { ...winner, photos };
  });
  const localIds = new Set(localWines.map(w => w.id));
  cloudWines.forEach(cw => { if (!localIds.has(cw.id)) merged.push(cw); });
  return merged;
}

// ── Cloud sync via Netlify Function ──
const IS_NETLIFY = window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1";

// Chiave localStorage per l'ETag del cloud sync
const ETAG_KEY = "cantina-cloud-etag";

async function cloudLoad() {
  if (!IS_NETLIFY) return null;
  try {
    const savedEtag = loadLocal(ETAG_KEY, null);
    const headers = {};
    if (savedEtag) headers["If-None-Match"] = savedEtag;

    const r = await fetch("/.netlify/functions/data", { headers });

    // 304 Not Modified: contenuto invariato, salta parsing/merge
    if (r.status === 304) {
      return { notModified: true };
    }

    if (!r.ok) return null;

    // Salva il nuovo ETag per il prossimo sync differenziale
    const newEtag = r.headers.get("etag") || r.headers.get("ETag");
    if (newEtag) saveLocal(ETAG_KEY, newEtag);

    return await r.json(); // { wines, racks, log }
  } catch { return null; }
}

// Debounced cloudSave: raggruppa salvataggi rapidi, vince sempre l'ultimo payload per chiave
let _cloudSaveTimer = null;
let _cloudSavePending = {};
let _onCloudSaveError = null; // callback registrata dal componente

function cloudSave(payload) {
  if (!IS_NETLIFY) return;
  _cloudSavePending = { ..._cloudSavePending, ...payload };
  clearTimeout(_cloudSaveTimer);
  _cloudSaveTimer = setTimeout(async () => {
    const toSave = _cloudSavePending;
    _cloudSavePending = {};
    const body = JSON.stringify(toSave);
    try {
      const r = await fetch("/.netlify/functions/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      // Se fallisce (es. payload troppo grande da base64 legacy), riprova
      // mantenendo solo gli URL (Supabase Storage). Base64 vengono strippati.
      try {
        const fallback = { ...toSave };
        if (fallback.wines) {
          fallback.wines = fallback.wines.map(w => ({
            ...w,
            photos: (w.photos || []).filter(
              p => typeof p === "string" && (p.startsWith("http://") || p.startsWith("https://"))
            ),
          }));
        }
        const r2 = await fetch("/.netlify/functions/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fallback),
        });
        if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
        _onCloudSaveError?.("⚠️ Alcune foto non sincronizzate — dati salvati");
      } catch {
        _onCloudSaveError?.("❌ Salvataggio cloud fallito — i dati sono al sicuro in locale");
      }
    }
  }, 500);
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
{ "name": "...", "producer": "...", "year": 2019, "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito", "region": "...", "grape": "...", "alcohol": 14.5, "notes": "...", "price": null }
Se un campo non è determinabile usa null. Il campo "alcohol" è la gradazione alcolica in %vol (numero decimale).`;

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
  const pf = wine.enrichment?.peakFrom;
  const pt = wine.enrichment?.peakTo;
  if (pf != null && pt != null && pt > pf) {
    const matEnd = pt + Math.ceil((pt - pf) / 2);
    if (age < pf)      return { s: "Giovane", c: "#6aaa6a" };
    if (age <= pt)     return { s: "Apice",   c: "#c9953a" };
    if (age <= matEnd) return { s: "Maturo",  c: "#b07030" };
    return                    { s: "Declino", c: "#9a5050" };
  }
  const profile = AGING_PROFILES[wine.type] || AGING_PROFILES["Rosso"];
  return profile.find(p => age <= p.max) || profile[profile.length - 1];
}

const emptyWine = () => ({
  id: null, name: "", producer: "", year: new Date().getFullYear(),
  region: "", grape: "", type: "", denomination: "",
  rating: 3, notes: "", quantity: 1, price: "", alcohol: "", bottleSize: "0.75",
  rackSlots: [], location: "", photos: [], enrichment: null,
});
const emptyRack = () => ({ id: null, name: "", rows: 4, cols: 6, house: "" });

export default function App() {
  const [wines,   setWines]   = useState(() => migrateWines(loadWinesLocal(INITIAL_WINES)));
  const [racks,   setRacks]   = useState(() => loadLocal(RACKS_KEY, INITIAL_RACKS));
  const [syncing, setSyncing] = useState(IS_NETLIFY); // true while loading from cloud
  const [view,    setView]    = useState("catalog"); // "catalog" | "racks" | "stats"
  const [search,  setSearch]  = useState("");
  const [filterType, setFilterType] = useState("Tutti");
  const [filterGrape, setFilterGrape] = useState(null);
  const [filterRegion, setFilterRegion] = useState(null);
  const [filterAging, setFilterAging] = useState("Tutti");
  const [filterUnracked, setFilterUnracked] = useState(false);
  const [filterUrgent, setFilterUrgent] = useState(false); // Maturo + Declino
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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
  const [tonightOpen, setTonightOpen] = useState(false); // modale "Apri stasera"
  const [tonightHouse, setTonightHouse] = useState(null); // filtro casa per "Apri stasera"
  const [searchModalOpen, setSearchModalOpen] = useState(false); // modale ricerca full-screen
  const [verticaleOpen, setVerticaleOpen] = useState(null); // {key, wines[]} della verticale aperta
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairingDish, setPairingDish] = useState("");
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingResult, setPairingResult] = useState(null); // {picks:[{wineId, reason}], error?}
  const [cellarSummary, setCellarSummary] = useState(() => loadLocal('cellar-summary', null));
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState(null);
  const [lightboxPhoto, setLightboxPhoto] = useState(null);
  const [cantinaName, setCantinaName] = useState(() => loadLocal('cantina-name', 'CANTINA VETTORELLO'));
  const [editingName, setEditingName] = useState(false);
  const [viewFromPos, setViewFromPos] = useState(null); // posizione rack che ha aperto il modal view
  const [lastSync, setLastSync] = useState(() => loadLocal('cantina-last-sync', null));
  const [pendingDrink, setPendingDrink] = useState(null); // {wine, newQty, newSlots}
  const [log, setLog] = useState(() => loadLocal(LOG_KEY, []));
  const [logModal, setLogModal] = useState(null); // wine being logged
  const [logEntry, setLogEntry] = useState(null); // current entry being edited
  const [logView, setLogView] = useState("list"); // "list" | "entry"
  const [logSearch, setLogSearch] = useState("");
  const [logFavOnly, setLogFavOnly] = useState(false);
  const [viewingEntry, setViewingEntry] = useState(null); // wine to drink from
  const [enriching, setEnriching] = useState(false);
  const [estimatingValue, setEstimatingValue] = useState(false);
  const [estimatedValue, setEstimatedValue] = useState(null); // {min, max, confidence, notes, source}
  const [enrichData, setEnrichData] = useState(null);
  const [enrichError, setEnrichError] = useState(null);
  const scanInputRef    = useRef(null);
  const secondPhotoRef  = useRef(null);
  const addPhotoRef     = useRef(null);
  const tastingPhotoRef = useRef(null);
  const [firstPhotoData, setFirstPhotoData] = useState(null); // {scanDataUrl, hiResDataUrl}
  const nextWineId = useRef(Math.max(...wines.map(w => w.id), 99) + 1);
  const nextRackId = useRef(Math.max(...racks.map(r => r.id), 99) + 1);
  const latestWinesRef = useRef(wines); // sempre aggiornato con l'ultimo stato React

  // Tiene latestWinesRef sempre aggiornato — usato da doCloudRefresh per il re-upload
  useEffect(() => { latestWinesRef.current = wines; }, [wines]);

  // Pulizia una-tantum: rimuovi i backup con foto che riempivano il localStorage
  useEffect(() => {
    try {
      const old = localStorage.getItem("cantina-wines-backup-v1");
      if (old && old.length > 500000) localStorage.removeItem("cantina-wines-backup-v1");
    } catch {}
  }, []);

  // Carica dal cloud al primo avvio, poi ri-analizza i vini con analisi scaduta (>6 mesi)
  useEffect(() => {
    if (!IS_NETLIFY) return;
    cloudLoad().then(data => {
      let loadedWines = null;
      if (data) {
        // Registra timestamp ultimo sync riuscito
        const now = Date.now();
        setLastSync(now);
        saveLocal('cantina-last-sync', now);

        // 304 Not Modified: il cloud non ha nulla di nuovo, usa solo localStorage
        if (data.notModified) {
          const localWines = loadWinesLocal([]);
          loadedWines = localWines;
          latestWinesRef.current = localWines;
          setWines(localWines);
          console.log("[cloudLoad] 304: stato invariato, uso localStorage");
          setSyncing(false);
          // Migra comunque eventuali foto base64 legacy in background
          if (loadedWines.length > 0) {
            setTimeout(() => migrateLegacyPhotos(loadedWines), 2500);
          }
          return;
        }

        if (data.wines) {
          const cloudWines = migrateWines(data.wines);
          const localWines = loadWinesLocal([]);
          loadedWines = mergeWines(localWines, cloudWines);
          latestWinesRef.current = loadedWines;
          setWines(loadedWines);
          // Persiste solo URL Supabase, le foto base64 restano in memoria
          // fino a quando vengono caricate su Storage (migrazione asincrona)
          saveLocal(STORAGE_KEY, loadedWines.map(w => ({
            ...w,
            photos: (w.photos || []).filter(isPhotoURL),
          })));
          cloudSave({ wines: loadedWines });
          const maxId = Math.max(...loadedWines.map(w => w.id), 99);
          if (nextWineId.current <= maxId) nextWineId.current = maxId + 1;
        }
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
        // Migra foto base64 legacy → Supabase Storage in background
        setTimeout(() => migrateLegacyPhotos(loadedWines), 2500);
      }
    });
  }, []);

  // Migrazione one-shot: se ci sono foto base64 nelle chiavi localStorage legacy
  // (cantina-photo-{id}), le carica su Supabase Storage e aggiorna wine.photos
  // con gli URL. Viene eseguita in background dopo il primo cloud sync.
  const migrateLegacyPhotos = async (wineList) => {
    const needsMigration = wineList.filter(
      w => (w.photos || []).some(isPhotoBase64)
    );
    if (needsMigration.length === 0) return;

    console.log(`[migration] ${needsMigration.length} vini con foto base64 legacy da caricare`);
    showToast(`📷 Migrazione foto cloud: ${needsMigration.length} vini…`);

    const updates = new Map();
    let succeeded = 0;
    for (const wine of needsMigration) {
      const newPhotos = [];
      for (let i = 0; i < (wine.photos || []).length; i++) {
        const p = wine.photos[i];
        if (isPhotoURL(p)) {
          newPhotos.push(p);
        } else if (isPhotoBase64(p)) {
          try {
            const url = await uploadPhotoToStorage(wine.id, i, p);
            newPhotos.push(url);
            succeeded++;
            console.log(`[migration] ${wine.id}/${i} → ${url.split("/").pop()}`);
          } catch (err) {
            console.error(`[migration] fallito ${wine.id}/${i}: ${err.message}`);
            newPhotos.push(p); // mantiene base64, riproverà al prossimo avvio
          }
        }
      }
      updates.set(wine.id, newPhotos);
    }

    if (updates.size === 0) return;

    setWines(current => {
      const newList = current.map(w =>
        updates.has(w.id)
          ? { ...w, photos: updates.get(w.id), lastModified: Date.now() }
          : w
      );
      // Persiste solo URL in localStorage
      saveLocal(STORAGE_KEY, newList.map(w => ({
        ...w,
        photos: (w.photos || []).filter(isPhotoURL),
      })));
      cloudSave({ wines: newList });
      return newList;
    });

    if (succeeded > 0) {
      showToast(`✨ Foto caricate su cloud: ${succeeded}`);
    }
  };

  const doCloudRefresh = () => {
    if (!IS_NETLIFY) return Promise.resolve();
    return cloudLoad().then(data => {
      if (!data) return;
      const now = Date.now();
      setLastSync(now);
      saveLocal('cantina-last-sync', now);
      // 304: nessun cambiamento dal cloud, non serve toccare lo stato
      if (data.notModified) {
        console.log("[doCloudRefresh] 304: stato invariato");
        return;
      }
      if (data.wines) {
        const cloudWines = migrateWines(data.wines);
        // Usa React state (current) come base locale — più affidabile di localStorage
        // perché localStorage può fallire silenziosamente per quota piena
        setWines(current => {
          const merged = mergeWines(current, cloudWines);
          // Fallback legacy: ri-legge foto da chiavi separate cantina-photo-{id}
          // se (e solo se) il vino non ne ha già nel suo array
          const mergedWithPhotos = loadWinePhotos(merged);
          const maxId = Math.max(...mergedWithPhotos.map(w => w.id), 99);
          if (nextWineId.current <= maxId) nextWineId.current = maxId + 1;
          saveLocal(STORAGE_KEY, mergedWithPhotos.map(w => ({
            ...w,
            photos: (w.photos || []).filter(isPhotoURL),
          })));
          return mergedWithPhotos;
        });
        // Usa React state (via ref) — più affidabile di localStorage che può fallire per quota
        setTimeout(() => { cloudSave({ wines: latestWinesRef.current }); }, 0);
      }
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

  // Sync manuale dal menu (ex pull-to-refresh)
  const handleManualSync = async () => {
    setMenuOpen(false);
    showToast("🔄 Sincronizzazione…");
    try {
      await doCloudRefresh();
      const now = Date.now();
      setLastSync(now);
      saveLocal('cantina-last-sync', now);
      showToast("✓ Sincronizzato");
    } catch {
      showToast("❌ Sync fallito");
    }
  };

  const saveWines = (w) => {
    const seen = new Set();
    const deduped = [...w].reverse().filter(wine => {
      if (seen.has(wine.id)) return false;
      seen.add(wine.id);
      return true;
    }).reverse();
    saveWinesBackup(deduped);
    latestWinesRef.current = deduped;
    setWines(deduped);
    // Persiste solo URL (Supabase Storage): base64 temporanei restano in memoria
    // fino all'upload, cosi localStorage non si riempie e il cloud non si bloata.
    saveLocal(STORAGE_KEY, deduped.map(wine => ({
      ...wine,
      photos: (wine.photos || []).filter(isPhotoURL),
    })));
    cloudSave({ wines: deduped }); // data.js lato server filtra comunque base64
  };
  const saveRacks = (r) => { setRacks(r); saveLocal(RACKS_KEY,  r); cloudSave({ racks: r }); };
  const saveLog   = (l) => { setLog(l);   saveLocal(LOG_KEY,   l); cloudSave({ log:   l }); };
  const saveName  = (n) => { setCantinaName(n); saveLocal('cantina-name', n); };
  const showToast = (msg) => { setToast(msg); setUndoState(null); setTimeout(() => setToast(null), 3000); };
  useEffect(() => { _onCloudSaveError = showToast; return () => { _onCloudSaveError = null; }; }, []);
  const showUndoToast = (msg, restore) => {
    setToast(msg);
    setUndoState({ restore });
    const t = setTimeout(() => { setToast(null); setUndoState(null); }, 5000);
    setUndoState({ restore, timer: t });
  };

  const activeWines = wines.filter(w => !w.deleted);
  // Elenco dinamico vitigni (split su "," / "&" per blend), ordinati per frequenza
  const splitGrapes = (s) => (s || "").split(/[,&/]+/).map(g => g.trim()).filter(Boolean);
  const grapeList = (() => {
    const counts = {};
    activeWines.forEach(w => splitGrapes(w.grape).forEach(g => { counts[g] = (counts[g] || 0) + 1; }));
    return Object.entries(counts).sort(([,a],[,b]) => b - a || 0).map(([k]) => k);
  })();

  // Lista case uniche: raccoglie valori da rack.house + wine.location (vini fuori scaffale)
  const houseList = (() => {
    const set = new Set();
    racks.forEach(r => { if (r.house && r.house.trim()) set.add(r.house.trim()); });
    activeWines.forEach(w => { if (w.location && w.location.trim()) set.add(w.location.trim()); });
    return Array.from(set).sort((a,b) => a.localeCompare(b));
  })();

  // Helper: restituisce la "casa" effettiva di un vino:
  // se ha rackSlots usa la house del primo rack assegnato, altrimenti usa wine.location
  const getWineHouse = (wine) => {
    const firstSlot = (wine.rackSlots || []).find(s => (s.positions || []).length > 0);
    if (firstSlot) {
      const rack = racks.find(r => r.id === firstSlot.rackId);
      return rack?.house || null;
    }
    return wine.location || null;
  };

  // "Apri stasera" — suggerisce fino a 3 bottiglie: priorità a urgenza + varietà
  // Scoring: Declino 30, Maturo 20, Apice 8, Giovane 0. Ultima bottiglia +6.
  // Bonus se non bevuto di recente (tipo non compare in log ultimi 7gg).
  // Penalità −20 se lo stesso vino è già nello storico negli ultimi 7 giorni.
  // `houseFilter`: se non null, considera solo vini in quella casa (via rack.house o wine.location).
  const computeTonightPicks = (houseFilter) => {
    const recentLog = log.slice().sort((a,b) => (b.date||"").localeCompare(a.date||"")).slice(0, 10);
    const recentTypes = new Set(recentLog.slice(0, 3).map(e => e.wineType).filter(Boolean));
    const recentIds = new Set(recentLog.filter(e => {
      if (!e.date) return false;
      const d = new Date(e.date); const now = new Date();
      return (now - d) / (1000*60*60*24) <= 7;
    }).map(e => e.wineId));
    const scored = activeWines
      .filter(w => (w.quantity || 0) > 0)
      .filter(w => !houseFilter || getWineHouse(w) === houseFilter)
      .map(w => {
        const ag = getAgingStatus(w);
        let score = 0;
        if (ag?.s === "Declino") score += 30;
        else if (ag?.s === "Maturo") score += 20;
        else if (ag?.s === "Apice")  score += 8;
        if ((w.quantity || 0) === 1) score += 6;
        if (recentTypes.has(w.type)) score -= 6;
        if (recentIds.has(w.id))     score -= 20;
        let reason = "";
        if (ag?.s === "Declino")      reason = "In declino, da aprire subito";
        else if (ag?.s === "Maturo")  reason = "Pronto, non aspettare troppo";
        else if (ag?.s === "Apice")   reason = "In piena forma";
        else if ((w.quantity || 0) === 1) reason = "Ultima bottiglia";
        else                          reason = ag?.s ? `${ag.s}, pronta da stappare` : "Pronta da stappare";
        return { wine: w, score, reason, aging: ag };
      })
      .filter(x => x.score > 0)
      .sort((a,b) => b.score - a.score);
    // Garantisci varietà di tipo nei top 3 (se possibile)
    const picks = [];
    const usedTypes = new Set();
    for (const x of scored) {
      if (picks.length >= 3) break;
      if (!usedTypes.has(x.wine.type)) { picks.push(x); usedTypes.add(x.wine.type); }
    }
    // Se non arriviamo a 3 con varietà, completa col resto
    if (picks.length < 3) {
      for (const x of scored) {
        if (picks.length >= 3) break;
        if (!picks.includes(x)) picks.push(x);
      }
    }
    return picks;
  };
  const tonightPicks = computeTonightPicks(null); // senza filtro casa, per la visibilità del bottone
  const tonightFilteredPicks = computeTonightPicks(tonightHouse); // con filtro casa, per il contenuto della modale
  const filtered = activeWines
    .filter(w => filterType === "Tutti" || w.type === filterType)
    .filter(w => !filterGrape || splitGrapes(w.grape).includes(filterGrape))
    .filter(w => !filterRegion || w.region === filterRegion)
    .filter(w => filterAging === "Tutti" || getAgingStatus(w)?.s === filterAging)
    .filter(w => !filterUrgent || ["Maturo","Declino"].includes(getAgingStatus(w)?.s))
    .filter(w => !filterUnracked || ((w.rackSlots||[]).reduce((sum, s) => sum + (s.positions||[]).length, 0) < (w.quantity || 0)))
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
      if (sortBy === "urgency") {
        const score = w => { const s = getAgingStatus(w)?.s; return s==="Declino"?4:s==="Maturo"?3:s==="Apice"?2:s==="Giovane"?1:0; };
        return score(b) - score(a);
      }
      return 0;
    });

  const totalBottles = activeWines.reduce((s, w) => s + w.quantity, 0);
  const totalValue   = activeWines.reduce((s, w) => s + w.quantity * (parseFloat(w.price) || 0), 0);

  // Verticali (sempre attive): raggruppa i vini per producer+name case-insensitive.
  // Un singolo vino senza "gemelli" diventa un gruppo di 1 e viene renderizzato come card normale.
  const verticaleKey = (w) => `${(w.producer||"").trim().toLowerCase()}::${(w.name||"").trim().toLowerCase()}`;
  const filteredGrouped = (() => {
    const groups = new Map();
    filtered.forEach(w => {
      const k = verticaleKey(w);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(w);
    });
    // Ordina le annate all'interno di ogni gruppo (più recente prima)
    return Array.from(groups.entries()).map(([key, ws]) => ({
      key,
      wines: ws.slice().sort((a,b) => (b.year||0) - (a.year||0)),
    }));
  })();

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
      alcohol:      info.alcohol != null ? String(info.alcohol) : prev.alcohol,
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
      // 800px/0.80 per le foto display: ~80-150KB base64, compatibile con localStorage e cloudSave
      const photo = await resizeImage(file, 800, 0.80);
      setEditing(prev => ({ ...prev, photos: [...(prev.photos||[]), photo] }));
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

  // Aggiungi una nuova annata dello stesso vino: copia i metadati stabili,
  // azzera i dati specifici dell'annata (photos, enrichment, rack, qty, note, prezzo)
  const addNewVintage = (fromWine) => {
    setModal(null);
    setEnrichData(null);
    setEnrichError(null);
    setScanError(null);
    setViewFromPos(null);
    setTimeout(() => {
      setEditing({
        ...emptyWine(),
        name: fromWine.name || "",
        producer: fromWine.producer || "",
        type: fromWine.type || "",
        region: fromWine.region || "",
        grape: fromWine.grape || "",
        denomination: fromWine.denomination || "",
        alcohol: fromWine.alcohol || "",
        bottleSize: fromWine.bottleSize || "0.75",
        // Copia enrichment dal vino sorgente: peakFrom/peakTo sono relativi alla
        // vendemmia e quindi validi per qualsiasi annata dello stesso vino.
        // Questo evita che l'AI dia valori diversi per la stessa etichetta e
        // generi stati di invecchiamento incoerenti (es. 2017 Maturo, 2018 Declino).
        enrichment: fromWine.enrichment || null,
        // year resta al default = anno corrente (sensibile per un acquisto recente)
      });
      setModal("add");
    }, 0);
  };

  // Helper: costruisce una log entry vuota precompilata dai dati del vino
  const makeLogEntryForWine = (wine) => ({
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
    // Quick tasting (rating veloce 1-5)
    quick_aromi: 0,
    quick_struttura: 0,
    quick_persistenza: 0,
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
    setLogEntry(makeLogEntryForWine(wine));
    setLogModal("add");
  };

  // Stima valore di mercato della bottiglia
  const handleEstimateValue = async (wine) => {
    setEstimatingValue(true);
    setEstimatedValue(null);
    try {
      const resp = await fetch("/.netlify/functions/estimate-value", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: wine.name, producer: wine.producer, year: wine.year,
          type: wine.type, region: wine.region, grape: wine.grape,
          alcohol: wine.alcohol || null,
          bottleSize: wine.bottleSize || "0.75",
        }),
      });
      if (!resp.ok) throw new Error(`Errore ${resp.status}`);
      const data = await resp.json();
      const valueData = { ...data, estimatedAt: new Date().toISOString() };
      setEstimatedValue(valueData);
      // Salva automaticamente nel vino senza bisogno di "Modifica"
      const updated = { ...wine, marketValue: valueData, lastModified: Date.now() };
      saveWines(wines.map(w => w.id === wine.id ? updated : w));
      setEditing(updated);
    } catch (err) {
      setEstimatedValue({ error: err.message || "Errore nella stima" });
    } finally {
      setEstimatingValue(false);
    }
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
      const updated = { ...wine, enrichment, lastModified: Date.now() };
      setWines(current => {
        const newList = current.map(w => w.id === wine.id ? updated : w);
        saveLocal(STORAGE_KEY, newList.map(({ photos: _, ...w }) => w));
        cloudSave({ wines: newList });
        return newList;
      });
      setEditing(updated);
      showToast("Analisi salvata nella scheda");
    } catch (err) {
      setEnrichError("Non sono riuscito a recuperare le informazioni. Riprova.");
    } finally {
      setEnriching(false);
    }
  };

  // Carica su Supabase Storage eventuali foto base64 presenti in editing.photos[],
  // sostituendole con gli URL pubblici. URL già presenti vengono mantenuti.
  // Ritorna l'array photos[] con solo URL (o il base64 originale se l'upload è fallito).
  const uploadPendingPhotos = async (wineId, photos) => {
    const result = [];
    let failed = 0;
    for (let i = 0; i < (photos || []).length; i++) {
      const p = photos[i];
      if (isPhotoURL(p)) {
        result.push(p); // già caricata
      } else if (isPhotoBase64(p)) {
        try {
          const url = await uploadPhotoToStorage(wineId, i, p);
          result.push(url);
        } catch (err) {
          console.error(`[upload] fallito per wine ${wineId}/${i}: ${err.message}`);
          result.push(p); // mantieni il base64 in memoria, riproveremo al prossimo save
          failed++;
        }
      } else {
        // Forma inattesa (null, undefined, oggetto): ignora
      }
    }
    return { photos: result, failed };
  };

  const handleSaveWine = async () => {
    if (!editing.name.trim()) return;
    if (!editing.type) { showToast("Seleziona una tipologia"); return; }
    if (!editing.region) { showToast("Seleziona una regione"); return; }

    const isAdd = modal === "add";
    const wineId = isAdd ? nextWineId.current : editing.id;

    // Se ci sono foto base64 da caricare, mostra il toast di upload
    const needsUpload = (editing.photos || []).some(isPhotoBase64);
    if (needsUpload) showToast("📷 Caricamento foto…");

    const { photos: uploadedPhotos, failed } = await uploadPendingPhotos(wineId, editing.photos);
    const uploadSuffix = failed > 0 ? ` (${failed} foto non caricate)` : "";

    if (isAdd) {
      nextWineId.current = wineId + 1;
      const wine = { ...editing, id: wineId, photos: uploadedPhotos, addedAt: Date.now(), lastModified: Date.now() };
      const newList = [...wines.filter(w => w.id !== wine.id), wine];
      saveWines(newList);
      setModal(null);
      // Salta autoEnrich se il vino ha già un enrichment (es. copiato da addNewVintage):
      // peakFrom/peakTo sono relativi alla vendemmia e validi per qualsiasi annata.
      if (wine.enrichment) {
        showToast(`"${wine.name}" aggiunto${uploadSuffix}`);
      } else {
        showToast(`"${wine.name}" aggiunto${uploadSuffix} — analisi in corso…`);
        setTimeout(() => autoEnrich(wine), 500);
      }
    } else {
      const original = wines.find(w => w.id === editing.id);
      const qtyDelta = (original?.quantity || 0) - (editing.quantity || 0);
      const updated = { ...editing, photos: uploadedPhotos, lastModified: Date.now() };
      saveWines(wines.map(w => w.id === editing.id ? updated : w));
      showToast(`"${editing.name}" aggiornato${uploadSuffix}`);
      setModal(null);
      // Auto-log: se la quantità è stata decrementata manualmente, proponi lo storico
      if (qtyDelta > 0) {
        setTimeout(() => {
          const msg = qtyDelta === 1
            ? `Hai stappato una bottiglia di "${updated.name}". Registrala nello storico?`
            : `Sono state rimosse ${qtyDelta} bottiglie di "${updated.name}". Registra una degustazione nello storico?`;
          if (window.confirm(msg)) {
            setLogEntry(makeLogEntryForWine(updated));
            setLogModal("add");
          }
        }, 250);
      }
    }
  };

  // Food pairing inverso: chiede a Claude i 2-3 vini della cantina più adatti al piatto
  const handlePairWine = async () => {
    const dish = pairingDish.trim();
    if (!dish) return;
    setPairingLoading(true);
    setPairingResult(null);
    try {
      const resp = await fetch("/.netlify/functions/pair-wine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dish,
          wines: activeWines.filter(w => (w.quantity||0) > 0).map(w => ({
            id: w.id, name: w.name, producer: w.producer, year: w.year,
            type: w.type, region: w.region, grape: w.grape,
            foodPairing: w.enrichment?.foodPairing || "",
          })),
        }),
      });
      if (!resp.ok) throw new Error(`Errore ${resp.status}`);
      const data = await resp.json();
      setPairingResult(data);
    } catch (err) {
      setPairingResult({ error: err.message || "Errore durante il pairing" });
    } finally {
      setPairingLoading(false);
    }
  };

  // Riassunto AI della cantina: paragrafo con composizione, punti di forza, lacune
  const handleSummarizeCellar = async () => {
    setSummarizing(true);
    setSummarizeError(null);
    try {
      const resp = await fetch("/.netlify/functions/summarize-cellar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wines: activeWines.map(w => ({
            name: w.name, producer: w.producer, year: w.year,
            type: w.type, region: w.region, grape: w.grape,
            quantity: w.quantity, price: w.price || null,
            agingStatus: getAgingStatus(w)?.s || null,
          })),
          log: log.slice(-30).map(e => ({
            wineName: e.wineName, wineType: e.wineType, wineGrape: e.wineGrape,
            date: e.date, rating: e.rating || 0, favorite: !!e.favorite,
          })),
        }),
      });
      if (!resp.ok) throw new Error(`Errore ${resp.status}`);
      const data = await resp.json();
      const summary = { ...data, generatedAt: new Date().toISOString(), totalBt: totalBottles };
      setCellarSummary(summary);
      saveLocal('cellar-summary', summary);
    } catch (err) {
      setSummarizeError(err.message || "Errore durante la generazione");
    } finally {
      setSummarizing(false);
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
      setWines(current => {
        // Usa il vino aggiornato da current, non l'oggetto stale passato ad autoEnrich
        const currentWine = current.find(w => w.id === wine.id);
        if (!currentWine) return current;
        const updated = { ...currentWine, enrichment, lastModified: Date.now() };
        const newList = current.map(w => w.id === wine.id ? updated : w);
        saveLocal(STORAGE_KEY, newList.map(({ photos: _, ...w }) => w));
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

  // v2 palette: deep wine & champagne — più elegante, meno "rustico marrone"
  const C = {
    bg: "#180b10",                 // vino nero profondo
    surface: "#241319",            // wine surface
    surface2: "#2e1a22",           // più chiaro, cards elevate
    border: "#3a2029",             // bordo sottile
    borderLight: "#563040",        // bordo accentato
    gold: "#d4a85a",               // champagne gold (meno arancio)
    goldLight: "#ead0a0",          // gold highlight
    text: "#f0e4d0",               // cream
    textMuted: "#b8a08a",          // warm muted
    textFaint: "#7a6352",          // low emphasis
    accent: "#8b1e3f",             // wine red (urgenza, highlight)
  };

  const inputStyle = {
    background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9,
    color: C.text, padding: "11px 14px", width: "100%",
    fontFamily: "'EB Garamond', serif", fontSize: 20, outline: "none",
    transition: "border-color 0.2s, box-shadow 0.2s",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.02)",
  };
  const labelStyle = {
    color: C.textFaint, fontSize: 12, letterSpacing: 2,
    fontFamily: "'Cinzel', serif", textTransform: "uppercase", marginBottom: 7, display: "block",
    fontWeight: 500,
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
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow: hidden; height: 100%; max-width: 100vw; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        input, select, textarea { color-scheme: dark; }
        input::placeholder, textarea::placeholder { color: ${C.textFaint}; }
        select option { background: ${C.surface}; color: ${C.text}; }
        input:focus, select:focus, textarea:focus { border-color: ${C.gold} !important; box-shadow: 0 0 0 2px rgba(201,149,58,0.14); }
        .wine-card { transition: transform 0.2s cubic-bezier(.2,.7,.3,1), box-shadow 0.2s, border-color 0.2s; position: relative; }
        .wine-card::before { content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; background: linear-gradient(135deg, transparent 50%, ${C.gold}20 100%); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; pointer-events: none; opacity: 0; transition: opacity 0.2s; }
        .wine-card:hover::before { opacity: 1; }
        .wine-card:hover { transform: translateY(-3px); box-shadow: 0 14px 32px rgba(0,0,0,0.5) !important; }
        .btn-gold { background: linear-gradient(135deg, #8a6828, ${C.gold} 50%, #8a6828); color: #1a0800; border: none; border-radius: 9px; padding: 12px 24px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 16px; letter-spacing: 1.5px; font-weight: 700; transition: opacity 0.15s, transform 0.12s, box-shadow 0.15s; white-space: nowrap; box-shadow: 0 4px 14px rgba(212,168,90,0.22); }
        .btn-gold:hover { opacity: 0.95; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(212,168,90,0.32); }
        .btn-ghost { background: transparent; color: ${C.textMuted}; border: 1px solid ${C.border}; border-radius: 9px; padding: 11px 22px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 16px; letter-spacing: 1px; transition: border-color 0.18s, color 0.18s, background 0.18s; white-space: nowrap; }
        .btn-ghost:hover { border-color: ${C.gold}; color: ${C.gold}; background: rgba(212,168,90,0.05); }
        .btn-sm { background: ${C.surface2}; color: ${C.textMuted}; border: 1px solid ${C.border}; border-radius: 7px; padding: 8px 16px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: all 0.18s; }
        .btn-sm:hover { color: ${C.gold}; border-color: ${C.gold}; }
        .btn-danger { background: transparent; color: #c07070; border: 1px solid #804040; border-radius: 9px; padding: 10px 16px; cursor: pointer; font-family: 'Cinzel', serif; font-size: 15px; letter-spacing: 1px; transition: background 0.15s, color 0.15s; }
        .btn-danger:hover { background: rgba(180,60,60,0.15); color: #e09090; }
        .tab-btn { background: none; border: 1px solid transparent; cursor: pointer; padding: 5px 11px; border-radius: 20px; font-family: 'Cinzel', serif; font-size: 12px; letter-spacing: 1px; transition: all 0.18s; }
        .tab-btn:hover { color: ${C.gold}; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.78); display: flex; align-items: flex-end; justify-content: center; z-index: 200; padding-top: env(safe-area-inset-top, 44px); overflow: hidden; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
        @media (min-width: 600px) { .modal-overlay { align-items: center; padding: 8px; } }
        .modal-box { background: linear-gradient(180deg, ${C.surface} 0%, ${C.surface2} 100%); border: 1px solid ${C.border}; border-radius: 16px; width: 100%; max-width: min(98vw, 1100px); max-height: 96svh; overflow-y: auto; -webkit-overflow-scrolling: touch; box-shadow: 0 40px 100px rgba(0,0,0,0.7), 0 0 0 1px rgba(212,168,90,0.06) inset; animation: fadeUp 0.24s cubic-bezier(.2,.7,.3,1); padding-bottom: env(safe-area-inset-bottom, 16px); }
        @keyframes fadeUp { from { opacity:0; transform: translateY(18px) scale(0.97); } to { opacity:1; transform: none; } }

        @media (max-width: 600px) {
          .wine-card { font-size: 15px !important; }
          .wine-card h3 { font-size: 17px !important; }
          .wine-card p  { font-size: 14px !important; }
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

      {/* ── HEADER + DROPDOWN MENU ── */}
      {(() => {
        const urgentCount = activeWines.filter(w => {
          if ((w.quantity || 0) <= 0) return false;
          const s = getAgingStatus(w)?.s;
          return s === "Maturo" || s === "Declino";
        }).length;
        const items = [
          { v: "catalog", l: "CATALOGO",    icon: "📋" },
          { v: "racks",   l: "SCAFFALI",    icon: "🗄" },
          { v: "stats",   l: "STATISTICHE", icon: "📊" },
          { v: "logview", l: "STORICO",     icon: "📖" },
        ];
        const current = items.find(i => i.v === view) || items[0];
        return (
          <div style={{
            background: `linear-gradient(180deg, ${C.surface} 0%, ${C.bg} 100%)`,
            borderBottom: `1px solid ${C.border}`,
            paddingTop: "env(safe-area-inset-top, 0px)", flexShrink: 0,
            position: "relative", zIndex: 50,
          }}>
            {/* Bottone menu — posizionato assolutamente in alto a destra */}
            <button onClick={() => setMenuOpen(o => !o)} aria-label="Menu" style={{
              position: "absolute", top: "calc(env(safe-area-inset-top, 0px) + 14px)", right: 14,
              background: menuOpen ? "rgba(212,168,90,0.16)" : "transparent",
              border: `1px solid ${menuOpen ? "rgba(212,168,90,0.5)" : C.border}`,
              borderRadius: 8, padding: "8px 11px", cursor: "pointer",
              color: menuOpen ? C.gold : C.textMuted,
              fontSize: 18, lineHeight: 1, transition: "all 0.15s", zIndex: 2,
            }}>
              ☰
              {urgentCount > 0 && (
                <span style={{
                  position: "absolute", top: -5, right: -5,
                  minWidth: 18, height: 18, padding: "0 5px",
                  background: C.accent, color: "#fff", borderRadius: 10,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "'Cinzel', serif", fontSize: 11, fontWeight: 700,
                  border: `2px solid ${C.surface}`, boxSizing: "content-box",
                }}>{urgentCount}</span>
              )}
            </button>

            {/* Vinario wordmark — sempre centrato */}
            <div style={{ padding: "16px 0 14px", textAlign: "center" }}>
              <div style={{
                fontFamily: "'Cormorant Garamond', 'Cinzel', serif",
                fontSize: 30, fontWeight: 300, letterSpacing: 12,
                color: C.goldLight,
                background: `linear-gradient(180deg, ${C.goldLight} 0%, ${C.gold} 60%, #a07830 100%)`,
                WebkitBackgroundClip: "text", backgroundClip: "text",
                WebkitTextFillColor: "transparent",
                paddingLeft: 12, // compensa letter-spacing a destra
                textTransform: "none",
                userSelect: "none",
              }}>Vinario</div>
              {/* Ornamento decorativo sotto il wordmark */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                marginTop: 2, opacity: 0.85,
              }}>
                <div style={{
                  height: 1, width: 48,
                  background: `linear-gradient(90deg, transparent, ${C.gold})`,
                }}/>
                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                  <div style={{ width: 3, height: 3, borderRadius: "50%", background: C.gold, opacity: 0.6 }}/>
                  <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.goldLight }}/>
                  <div style={{ width: 3, height: 3, borderRadius: "50%", background: C.gold, opacity: 0.6 }}/>
                </div>
                <div style={{
                  height: 1, width: 48,
                  background: `linear-gradient(90deg, ${C.gold}, transparent)`,
                }}/>
              </div>
            </div>

            {/* Dropdown */}
            {menuOpen && (
              <>
                <div onClick={() => setMenuOpen(false)} style={{
                  position: "fixed", inset: 0, zIndex: 49, background: "transparent",
                }} />
                <div style={{
                  position: "absolute", top: "100%", right: 10, zIndex: 51,
                  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
                  boxShadow: "0 14px 40px rgba(0,0,0,0.55)",
                  minWidth: 240, padding: 6, marginTop: 4,
                  animation: "fadeUp 0.15s ease",
                }}>
                  {/* Urgenti — jump a catalogo filtrato */}
                  {urgentCount > 0 && (
                    <>
                      <button onClick={() => {
                        setFilterType("Tutti"); setFilterGrape(null); setFilterRegion(null);
                        setFilterAging("Tutti"); setFilterUnracked(false); setFilterUrgent(true);
                        setSearch(""); setView("catalog"); setMenuOpen(false);
                      }} style={{
                        display: "flex", alignItems: "center", gap: 10, width: "100%",
                        background: "rgba(154,80,80,0.15)", border: "1px solid rgba(154,80,80,0.4)",
                        borderRadius: 7, padding: "11px 13px", cursor: "pointer",
                        color: "#d08080", fontFamily: "'Cinzel', serif", fontSize: 13,
                        letterSpacing: 1, fontWeight: 700, textAlign: "left",
                        transition: "all 0.15s",
                      }}
                        onMouseEnter={e => { e.currentTarget.style.background = "rgba(154,80,80,0.25)"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "rgba(154,80,80,0.15)"; }}>
                        <span style={{ fontSize: 16 }}>⚠</span>
                        <span style={{ flex: 1 }}>{urgentCount} VINI DA BERE</span>
                        <span style={{ fontSize: 16, opacity: 0.7 }}>›</span>
                      </button>
                      <div style={{ height: 1, background: C.border, margin: "6px 2px" }} />
                    </>
                  )}
                  {items.map(({ v, l, icon }) => {
                    const active = view === v;
                    return (
                      <button key={v} onClick={() => {
                        setView(v);
                        // Reset del filtro urgenti quando cambi vista liberamente dal menu
                        if (v !== "catalog") setFilterUrgent(false);
                        setMenuOpen(false);
                      }} style={{
                        display: "flex", alignItems: "center", gap: 12, width: "100%",
                        background: active ? "rgba(201,149,58,0.14)" : "transparent",
                        border: `1px solid ${active ? "rgba(201,149,58,0.4)" : "transparent"}`,
                        borderRadius: 7, padding: "11px 13px", cursor: "pointer",
                        color: active ? C.gold : C.textMuted,
                        fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1.5, fontWeight: active ? 700 : 400,
                        textAlign: "left", marginTop: 2, transition: "all 0.15s",
                      }}
                        onMouseEnter={e => { if (!active) { e.currentTarget.style.background = "rgba(201,149,58,0.07)"; e.currentTarget.style.color = C.gold; } }}
                        onMouseLeave={e => { if (!active) { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; } }}>
                        <span style={{ fontSize: 16 }}>{icon}</span>
                        <span style={{ flex: 1 }}>{l}</span>
                        {active && <span style={{ fontSize: 14, color: C.gold }}>●</span>}
                      </button>
                    );
                  })}

                  {/* ── Azioni rapide ── */}
                  <div style={{ height: 1, background: C.border, margin: "6px 2px" }} />

                  {/* Cerca */}
                  <button onClick={() => { setMenuOpen(false); setView("catalog"); setSearchModalOpen(true); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      background: "transparent", border: "1px solid transparent",
                      borderRadius: 7, padding: "11px 13px", cursor: "pointer",
                      color: C.textMuted,
                      fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1.5,
                      textAlign: "left", marginTop: 2, transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(201,149,58,0.07)"; e.currentTarget.style.color = C.gold; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; }}>
                    <span style={{ fontSize: 16 }}>🔍</span>
                    <span style={{ flex: 1 }}>CERCA</span>
                    {search && (
                      <span style={{ fontSize: 10, color: C.gold, fontStyle: "italic", letterSpacing: 0 }}>"{search.substring(0, 12)}{search.length > 12 ? "…" : ""}"</span>
                    )}
                  </button>

                  {/* Filtri (accesso rapido dal menu, oltre che dal bottone inline) */}
                  <button onClick={() => { setMenuOpen(false); setView("catalog"); setFiltersOpen(true); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      background: "transparent", border: "1px solid transparent",
                      borderRadius: 7, padding: "11px 13px", cursor: "pointer",
                      color: C.textMuted,
                      fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1.5,
                      textAlign: "left", marginTop: 2, transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(201,149,58,0.07)"; e.currentTarget.style.color = C.gold; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; }}>
                    <span style={{ fontSize: 16 }}>⚙</span>
                    <span style={{ flex: 1 }}>FILTRI</span>
                  </button>

                  {/* Abbina — food pairing */}
                  <button onClick={() => { setMenuOpen(false); setPairingOpen(true); setPairingResult(null); }}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      background: "transparent", border: "1px solid transparent",
                      borderRadius: 7, padding: "11px 13px", cursor: "pointer",
                      color: C.textMuted,
                      fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1.5,
                      textAlign: "left", marginTop: 2, transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(122,186,138,0.1)"; e.currentTarget.style.color = "#a0d0a8"; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; }}>
                    <span style={{ fontSize: 16 }}>🍽</span>
                    <span style={{ flex: 1 }}>ABBINA A PIATTO</span>
                    <span style={{ fontSize: 16, opacity: 0.5 }}>›</span>
                  </button>

                  {/* Sync manuale */}
                  <button onClick={handleManualSync}
                    style={{
                      display: "flex", alignItems: "center", gap: 12, width: "100%",
                      background: "transparent", border: "1px solid transparent",
                      borderRadius: 7, padding: "11px 13px", cursor: "pointer",
                      color: C.textMuted,
                      fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1.5,
                      textAlign: "left", marginTop: 2, transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = "rgba(201,149,58,0.07)"; e.currentTarget.style.color = C.gold; }}
                    onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = C.textMuted; }}>
                    <span style={{ fontSize: 16 }}>🔄</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>SINCRONIZZA</div>
                      {lastSync && (
                        <div style={{ fontSize: 10, color: C.textFaint, fontFamily: "'EB Garamond', serif", fontStyle: "italic", letterSpacing: 0, marginTop: 2 }}>
                          Ultimo: {new Date(lastSync).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })} · {new Date(lastSync).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ══════ CATALOG VIEW ══════ */}
      {view === "catalog" && (() => {
        const activeFiltersCount = [
          filterType !== "Tutti",
          !!filterGrape,
          !!filterRegion,
          filterAging !== "Tutti",
          filterUnracked,
          filterUrgent,
        ].filter(Boolean).length;
        const hasSearch = !!search.trim();
        const showChipBar = hasSearch || activeFiltersCount > 0;
        return (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
        {/* Chip bar: compare solo se c'è una ricerca attiva o filtri attivi */}
        {showChipBar && (
          <div style={{
            padding: "10px 14px", background: C.surface, borderBottom: `1px solid ${C.border}`,
            display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", flexShrink: 0,
          }}>
            {hasSearch && (
              <span onClick={() => setSearch("")} style={{
                fontSize: 11, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 1,
                background: "rgba(212,168,90,0.12)", border: "1px solid rgba(212,168,90,0.35)",
                borderRadius: 14, padding: "4px 12px", cursor: "pointer", whiteSpace: "nowrap",
              }} title="Rimuovi ricerca">
                🔍 {search} ✕
              </span>
            )}
            {activeFiltersCount > 0 && (
              <span onClick={() => {
                setFilterType("Tutti"); setFilterGrape(null); setFilterRegion(null);
                setFilterAging("Tutti"); setFilterUnracked(false); setFilterUrgent(false);
              }} style={{
                fontSize: 11, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 1,
                background: "rgba(212,168,90,0.12)", border: "1px solid rgba(212,168,90,0.35)",
                borderRadius: 14, padding: "4px 12px", cursor: "pointer", whiteSpace: "nowrap",
              }} title="Rimuovi tutti i filtri">
                ⚙ {[
                  filterType !== "Tutti" ? filterType : null,
                  filterGrape,
                  filterRegion,
                  filterAging !== "Tutti" ? filterAging : null,
                  filterUrgent ? "Urgenti" : null,
                  filterUnracked ? "Senza scaffale" : null,
                ].filter(Boolean).join(" · ")} ✕
              </span>
            )}
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px", paddingBottom: 100 }}>
          {/* ── Tonight section: banner con bottiglie da stappare oggi ── */}
          {tonightPicks.length > 0 && !showChipBar && (
            <div style={{
              background: `linear-gradient(180deg, ${C.surface} 0%, ${C.surface2} 100%)`,
              border: `1px solid ${C.border}`, borderRadius: 12,
              padding: "14px 16px 12px", marginBottom: 18,
              boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontFamily: "'Cinzel', serif", fontSize: 12, color: C.gold, letterSpacing: 2, fontWeight: 700 }}>
                  🍷 DA APRIRE STASERA
                </div>
                {tonightFilteredPicks.length < tonightPicks.length && (
                  <button onClick={() => setTonightHouse(null)} style={{
                    background: "none", border: "none", color: C.textFaint,
                    cursor: "pointer", fontSize: 10, fontFamily: "'Cinzel', serif", letterSpacing: 1,
                  }}>✕ filtro casa</button>
                )}
              </div>
              {/* Pills casa se >= 2 case */}
              {houseList.length >= 2 && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 10 }}>
                  <button onClick={() => setTonightHouse(null)} className="tab-btn" style={{
                    color: !tonightHouse ? C.gold : C.textFaint,
                    background: !tonightHouse ? "rgba(212,168,90,0.16)" : "none",
                    border: !tonightHouse ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                    fontSize: 10,
                  }}>TUTTE</button>
                  {houseList.map(h => (
                    <button key={h} onClick={() => setTonightHouse(h)} className="tab-btn" style={{
                      color: tonightHouse === h ? C.gold : C.textFaint,
                      background: tonightHouse === h ? "rgba(212,168,90,0.16)" : "none",
                      border: tonightHouse === h ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                      fontSize: 10,
                    }}>🏠 {h.toUpperCase()}</button>
                  ))}
                </div>
              )}
              {/* Lista vini suggeriti */}
              {tonightFilteredPicks.length === 0 ? (
                <p style={{ fontSize: 13, color: C.textFaint, fontStyle: "italic", padding: "8px 0" }}>
                  Nessun suggerimento {tonightHouse ? `in ${tonightHouse}` : ""}.
                </p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {tonightFilteredPicks.map(({ wine, reason, aging }, idx) => {
                    const tc = typeColors[wine.type] || { bar: "#888" };
                    return (
                      <div key={wine.id}
                        onClick={() => { setEditing({...wine}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setEstimatedValue(null); setModal("view"); }}
                        style={{
                          background: C.bg, border: `1px solid ${aging?.c || C.border}`, borderRadius: 8,
                          padding: "8px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                          transition: "all 0.15s",
                        }}>
                        <div style={{ flexShrink: 0, width: 4, alignSelf: "stretch", background: tc.bar, borderRadius: 2 }} />
                        {(wine.photos || [])[0] && (
                          <img src={wine.photos[0]} alt={wine.name}
                            style={{ flexShrink: 0, width: 32, height: 42, objectFit: "cover", borderRadius: 3, border: `1px solid ${C.border}` }} />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {wine.name}
                          </div>
                          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 11, color: C.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                            {[wine.producer, wine.year].filter(Boolean).join(" · ")} · <em style={{ color: aging?.c || C.textFaint }}>{reason}</em>
                          </div>
                        </div>
                        <div style={{ flexShrink: 0, fontSize: 14, color: C.gold, opacity: 0.6 }}>›</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 20px", color: C.textFaint }}>
              <div style={{ fontSize: 48, marginBottom: 14, opacity: 0.4 }}>🍷</div>
              <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 2, fontSize: 15 }}>{activeWines.length===0?"LA CANTINA È VUOTA":"NESSUN RISULTATO"}</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 320px), 1fr))", gap: 18 }}>
              {filteredGrouped.map(group => {
                const wine = group.wines[0]; // rappresentativa = più recente
                const isGroup = group.wines.length > 1;
                const groupTotalBt = group.wines.reduce((s,w) => s + (w.quantity || 0), 0);
                const groupYearsMin = isGroup ? Math.min(...group.wines.map(w => w.year || 9999)) : null;
                const groupYearsMax = isGroup ? Math.max(...group.wines.map(w => w.year || 0))  : null;
                const tc = typeColors[wine.type] || { bar: "#888" };
                // Urgenza del gruppo: la peggiore annata (Declino > Maturo > Apice > Giovane)
                const agingRank = s => s === "Declino" ? 4 : s === "Maturo" ? 3 : s === "Apice" ? 2 : s === "Giovane" ? 1 : 0;
                const worstAg = group.wines.reduce((worst, w) => {
                  const a = getAgingStatus(w);
                  return (agingRank(a?.s) > agingRank(worst?.s)) ? a : worst;
                }, null);
                const ag = worstAg;
                const urgent = ag?.s === "Declino" || ag?.s === "Maturo";
                const urgentBorder = ag?.s === "Declino" ? "#9a5050" : "#b07030";
                const urgentWidth  = ag?.s === "Maturo" ? "2px" : "1px";
                return (
                  <div key={isGroup ? group.key : wine.id} className="wine-card" style={{
                    background: `linear-gradient(180deg, ${C.surface} 0%, ${C.surface2} 100%)`,
                    border: urgent ? `${urgentWidth} solid ${urgentBorder}` : `1px solid ${C.border}`,
                    borderRadius: 12, overflow: "hidden", cursor: "pointer",
                    boxShadow: urgent
                      ? `0 4px 18px ${urgentBorder}3a, 0 0 0 1px ${urgentBorder}22 inset`
                      : "0 4px 16px rgba(0,0,0,0.3)",
                    position: "relative",
                  }}
                    onClick={() => {
                      if (isGroup) { setVerticaleOpen(group); return; }
                      setEditing({...wine}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setEstimatedValue(null); setModal("view");
                    }}>
                    <div style={{ height: 3, background: `linear-gradient(90deg, ${tc.bar} 0%, ${tc.bar}dd 100%)` }} />

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
                            <FitText text={wine.name} maxSize={20} minSize={12}
                              style={{fontFamily:"'Cinzel',serif",fontWeight:700,color:C.text,lineHeight:1.2,flex:1,minWidth:0}} />
                            <span style={{
                              background:groupTotalBt===0?"rgba(180,60,60,0.25)":groupTotalBt<=2?"rgba(180,150,60,0.25)":"rgba(60,150,60,0.2)",
                              color:groupTotalBt===0?"#d07070":groupTotalBt<=2?"#c0b040":"#70c070",
                              padding:"1px 8px",borderRadius:20,fontSize:16,flexShrink:0,
                              fontFamily:"'Cinzel',serif",fontWeight:700,
                            }}>{groupTotalBt}bt</span>
                          </div>
                          <div style={{fontFamily:"'Cinzel',serif",fontSize:13,color:C.textMuted,fontWeight:400,marginTop:2,
                            minHeight:"1.3em",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {wine.denomination||""}
                          </div>
                        </div>

                        {/* Blocco mid: produttore · anno/e (+ prezzo) */}
                        <div>
                          <p style={{fontFamily:"'Cinzel',serif",fontSize:16,
                            color:C.text,margin:0,lineHeight:1.3,
                            overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {isGroup
                              ? [wine.producer, `${groupYearsMin}–${groupYearsMax}`].filter(Boolean).join(" · ")
                              : [wine.producer, wine.year].filter(Boolean).join(" · ")
                            }
                          </p>
                          {!isGroup && wine.price && (
                            <p style={{fontFamily:"'Cinzel',serif",fontSize:14,color:C.textMuted,margin:"2px 0 0"}}>€{wine.price}</p>
                          )}
                        </div>

                        {/* Blocco bottom: se gruppo → chip per ogni annata; altrimenti → scaffale + invecchiamento singolo */}
                        {isGroup ? (
                          <div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
                            {group.wines.map(w => {
                              const wag = getAgingStatus(w);
                              const wc = wag?.c || C.border;
                              const emo = wag?.s === "Giovane" ? "🌱" : wag?.s === "Apice" ? "⭐" : wag?.s === "Maturo" ? "🍂" : wag?.s === "Declino" ? "📉" : "";
                              return (
                                <span key={w.id} style={{
                                  fontSize: 11, color: wc, fontFamily: "'Cinzel', serif", fontWeight: 700,
                                  background: `${wc}12`, border: `1px solid ${wc}45`,
                                  borderRadius: 14, padding: "2px 7px", whiteSpace: "nowrap",
                                }}>
                                  {w.year} · {w.quantity || 0}bt {emo}
                                </span>
                              );
                            })}
                          </div>
                        ) : ((wine.rackSlots||[]).some(s=>(s.positions||[]).length>0) || wine.location || getAgingStatus(wine)) && (
                          <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
                            {(()=>{
                              const slotsWithPos=(wine.rackSlots||[]).filter(s=>(s.positions||[]).length>0);
                              if(!slotsWithPos.length){
                                // Nessuno scaffale: mostra la location se presente
                                if(wine.location){
                                  return(
                                    <span style={{fontSize:12,color:C.gold,fontFamily:"'Cinzel',serif",
                                      background:"rgba(212,168,90,0.08)",border:`1px dashed rgba(212,168,90,0.4)`,
                                      borderRadius:20,padding:"2px 8px",fontWeight:600}}>
                                      📍 {wine.location}
                                    </span>
                                  );
                                }
                                return null;
                              }
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
                              const pf=wine.enrichment?.peakFrom, pt=wine.enrichment?.peakTo;
                              const label = (pf!=null&&pt!=null)
                                ? `${wine.year+pf}–${wine.year+pt}`
                                : `${age}a`;
                              return(
                                <span style={{fontSize:12,color:ag.c,fontFamily:"'Cinzel',serif",fontWeight:700,
                                  background:`${ag.c}12`,border:`1px solid ${ag.c}35`,
                                  borderRadius:20,padding:"2px 8px"}}>
                                  {ag.s==="Giovane"?"🌱":ag.s==="Apice"?"⭐":ag.s==="Maturo"?"🍂":"📉"} {label}
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
        </div>
        );
      })()}

      {/* ══════ RACKS VIEW ══════ */}
      {view === "racks" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", paddingBottom: 100 }}>
          <div style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.gold, letterSpacing: 2, marginBottom: 6 }}>I MIEI SCAFFALI</h2>
              <p style={{ fontSize: 15, color: C.textMuted, fontStyle: "italic" }}>Ogni cella è una posizione A1, B3… Clicca su una bottiglia per i dettagli.</p>
            </div>
            <button onClick={() => { setEditingRack(emptyRack()); setRackModal("add"); }}
              className="btn-sm" style={{ whiteSpace: "nowrap", flexShrink: 0, fontSize: 12, padding: "8px 14px" }}>
              ＋ NUOVO
            </button>
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
        const totalBt = activeWines.reduce((s,w) => s+w.quantity, 0);
        const byType  = {}, byGrape = {}, byRegion = {};
        activeWines.forEach(w => {
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
        const goToFilter = (type, value) => {
          setFilterType("Tutti"); setFilterGrape(null); setFilterRegion(null);
          setFilterAging("Tutti"); setFilterUnracked(false); setSearch("");
          if (type === "type")   setFilterType(value);
          if (type === "grape")  setFilterGrape(value);
          if (type === "region") setFilterRegion(value);
          setView("catalog");
        };
        const Section = ({ title, rows, color, filterType: ft }) => (
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, overflow:"hidden" }}>
            <div style={{ padding:"14px 20px", borderBottom:`1px solid ${C.border}`, fontFamily:"'Cinzel', serif", fontSize:15, color:C.gold, letterSpacing:2 }}>{title}</div>
            <div style={{ padding:"12px 20px", display:"flex", flexDirection:"column", gap:10 }}>
              {rows.map(r => (
                <div key={r.label} onClick={() => goToFilter(ft, r.label)}
                  style={{ cursor:"pointer", borderRadius:8, padding:"4px 6px", margin:"-4px -6px",
                    transition:"background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = `${color}18`}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
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
          <div style={{ flex:1, overflowY:"auto", minHeight:0 }}><div style={{ padding:"20px 16px", display:"flex", flexDirection:"column", gap:16 }}>
            <h2 style={{ fontFamily:"'Cinzel', serif", fontSize:18, color:C.gold, letterSpacing:2 }}>COMPOSIZIONE DELLA CANTINA</h2>

            {/* Riassunto AI della cantina */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ fontFamily: "'Cinzel', serif", fontSize: 15, color: C.gold, letterSpacing: 2 }}>✨ ANALISI AI</div>
                <button onClick={handleSummarizeCellar} disabled={summarizing} style={{
                  background: summarizing ? C.surface2 : "rgba(201,149,58,0.14)",
                  border: "1px solid rgba(201,149,58,0.4)", borderRadius: 8,
                  padding: "6px 13px", cursor: summarizing ? "not-allowed" : "pointer",
                  color: C.gold, fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1, fontWeight: 700,
                  whiteSpace: "nowrap",
                }}>
                  {summarizing ? "…" : cellarSummary ? "🔄 AGGIORNA" : "✨ GENERA"}
                </button>
              </div>
              <div style={{ padding: "16px 20px" }}>
                {summarizing && (
                  <div style={{ textAlign: "center", padding: "30px 10px", color: C.textFaint }}>
                    <div className="spinner" style={{ margin: "0 auto 14px", width: 24, height: 24 }} />
                    <p style={{ fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1 }}>IL SOMMELIER STA ANALIZZANDO…</p>
                  </div>
                )}
                {!summarizing && summarizeError && (
                  <div style={{ padding: "10px 12px", background: "rgba(154,80,80,0.15)", border: "1px solid rgba(154,80,80,0.4)", borderRadius: 8, color: "#d08080", fontSize: 13 }}>
                    ⚠ {summarizeError}
                  </div>
                )}
                {!summarizing && cellarSummary && !summarizeError && (
                  <>
                    {Array.isArray(cellarSummary.highlights) && cellarSummary.highlights.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                        {cellarSummary.highlights.map((h, i) => (
                          <div key={i} style={{
                            fontFamily: "'Cinzel', serif", fontSize: 12, color: C.gold, letterSpacing: 0.5,
                            background: "rgba(201,149,58,0.08)", borderLeft: `2px solid ${C.gold}`,
                            padding: "6px 12px", borderRadius: "0 6px 6px 0",
                          }}>{h}</div>
                        ))}
                      </div>
                    )}
                    {cellarSummary.summary && (
                      <div style={{ fontFamily: "'EB Garamond', serif", fontSize: 15, color: C.text, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                        {cellarSummary.summary}
                      </div>
                    )}
                    <p style={{ fontSize: 11, color: C.textFaint, fontStyle: "italic", marginTop: 12, textAlign: "right" }}>
                      Aggiornato il {new Date(cellarSummary.generatedAt).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
                      {cellarSummary.totalBt !== totalBt && ` · la cantina è cambiata (${cellarSummary.totalBt}→${totalBt} bt)`}
                    </p>
                  </>
                )}
                {!summarizing && !cellarSummary && !summarizeError && (
                  <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic", lineHeight: 1.5 }}>
                    Claude analizza la tua cantina: composizione, punti di forza, lacune e priorità. Tocca <strong style={{ color: C.gold }}>✨ GENERA</strong> per iniziare.
                  </p>
                )}
              </div>
            </div>

            {/* KPI */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(120px,1fr))", gap:10 }}>
              {[
                ["🍾","Bottiglie",totalBt],
                ["🏷","Etichette",activeWines.length],
                ["🗄","Scaffali",racks.length],
                ["📖","Degustazioni",log.length],
                ["💰","Valore",`€${activeWines.reduce((s,w)=>s+w.quantity*(parseFloat(w.price)||0),0).toFixed(0)}`],
              ].map(([icon,label,val])=>(
                <div key={label} style={{ background:C.surface, border:`1px solid ${C.border}`,
                  borderRadius:10, padding:"12px 14px", textAlign:"center" }}>
                  <div style={{ fontSize:20, marginBottom:3 }}>{icon}</div>
                  <div style={{ fontSize:22, fontWeight:300, color:C.gold, fontFamily:"'Cinzel',serif" }}>{val}</div>
                  <div style={{ fontSize:11, color:C.textFaint, fontFamily:"'Cinzel',serif", letterSpacing:1, marginTop:2 }}>{label.toUpperCase()}</div>
                </div>
              ))}
            </div>

            <Section title="PER TIPOLOGIA" rows={mkRows(byType)}   color={C.gold}    filterType="type"/>
            <Section title="PER VITIGNO"   rows={mkRows(byGrape)}  color="#7a9aba"   filterType="grape"/>
            <Section title="PER REGIONE"   rows={mkRows(byRegion)} color="#8aba7a"   filterType="region"/>
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
                  <input style={inputStyle} type="text" inputMode="numeric" pattern="[0-9]*" value={editing.year} onChange={e=>{const y=parseInt(e.target.value.replace(/\D/g,''));if(!isNaN(y))setEditing(v=>({...v,year:y}));}} />
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
                  <div style={{display:"flex",alignItems:"center",gap:0,background:C.bg,border:`1px solid ${C.border}`,borderRadius:7,overflow:"hidden"}}>
                    <button type="button" onClick={()=>setEditing(v=>({...v,quantity:Math.max(0,v.quantity-1)}))}
                      style={{padding:"11px 18px",background:"none",border:"none",color:C.gold,fontSize:22,cursor:"pointer",lineHeight:1,fontFamily:"monospace"}}>−</button>
                    <span style={{flex:1,textAlign:"center",color:C.text,fontFamily:"'Cinzel',serif",fontSize:18,fontWeight:700}}>{editing.quantity}</span>
                    <button type="button" onClick={()=>setEditing(v=>({...v,quantity:v.quantity+1}))}
                      style={{padding:"11px 18px",background:"none",border:"none",color:C.gold,fontSize:22,cursor:"pointer",lineHeight:1,fontFamily:"monospace"}}>+</button>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>Prezzo (€)</label>
                  <input style={inputStyle} type="number" min="0" value={editing.price} onChange={e=>setEditing(v=>({...v,price:e.target.value}))} placeholder="es. 45"/>
                </div>
                <div>
                  <label style={labelStyle}>Gradazione (%vol)</label>
                  <input style={inputStyle} type="number" min="0" max="100" step="0.1" value={editing.alcohol||""} onChange={e=>setEditing(v=>({...v,alcohol:e.target.value}))} placeholder="es. 14.5"/>
                </div>
                <div>
                  <label style={labelStyle}>Formato (L)</label>
                  <select style={inputStyle} value={editing.bottleSize||"0.75"} onChange={e=>setEditing(v=>({...v,bottleSize:e.target.value}))}>
                    <option value="0.375">0,375 L (mezza)</option>
                    <option value="0.5">0,5 L</option>
                    <option value="0.75">0,75 L (standard)</option>
                    <option value="1">1 L</option>
                    <option value="1.5">1,5 L (magnum)</option>
                    <option value="3">3 L (jeroboam)</option>
                    <option value="5">5 L</option>
                  </select>
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
                            {racks.map(r=><option key={r.id} value={r.id}>{r.name}{r.house?` · ${r.house}`:""}</option>)}
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

                {/* Location per vini fuori scaffale — casa/posto senza assegnazione scaffale */}
                {(() => {
                  const totalAssignedSlots = (editing.rackSlots || []).reduce((sum, s) => sum + (s.positions || []).length, 0);
                  const hasUnracked = (editing.quantity || 0) > totalAssignedSlots;
                  if (!hasUnracked) return null;
                  const unrackedCount = (editing.quantity || 0) - totalAssignedSlots;
                  return (
                    <div style={{gridColumn:"1/-1",background:C.bg,borderRadius:9,padding:"16px 18px",border:`1px dashed rgba(212,168,90,0.35)`}}>
                      <p style={{...labelStyle,marginBottom:8}}>📍 Dove si trovano le {unrackedCount === 1 ? "bottiglie fuori scaffale" : `${unrackedCount} bottiglie fuori scaffale`}?</p>
                      <input
                        style={inputStyle}
                        value={editing.location || ""}
                        onChange={e=>setEditing(v=>({...v,location:e.target.value}))}
                        placeholder="es. Casa Milano, Cantina nonna, Ufficio…"
                        list="houses-datalist"
                      />
                      <p style={{fontSize:12,color:C.textFaint,fontStyle:"italic",marginTop:6}}>
                        Stessa lista delle case degli scaffali. Lascia vuoto se non lo sai.
                      </p>
                    </div>
                  );
                })()}

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
        // Fratelli nella stessa verticale (stesso producer+name, annate diverse)
        const siblings = activeWines
          .filter(w => verticaleKey(w) === verticaleKey(editing) && w.id !== editing.id)
          .sort((a,b) => (a.year||0) - (b.year||0));
        const allVintages = [...siblings, editing].sort((a,b) => (a.year||0) - (b.year||0));
        const hasVertical = siblings.length > 0;
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

                {/* Navigazione verticale: pill per ogni annata */}
                {hasVertical && (
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12,marginTop:4}}>
                    {allVintages.map(w => {
                      const isCurrent = w.id === editing.id;
                      const ag = getAgingStatus(w);
                      return (
                        <button key={w.id} onClick={() => {
                          if (!isCurrent) {
                            setEditing({...w});
                            setEnrichData(null);
                            setEnrichError(null);
                            setEstimatedValue(null);
                          }
                        }} style={{
                          background: isCurrent ? "rgba(212,168,90,0.2)" : C.bg,
                          border: `1px solid ${isCurrent ? C.gold : ag?.c || C.border}`,
                          borderRadius: 20, padding: "4px 12px", cursor: isCurrent ? "default" : "pointer",
                          color: isCurrent ? C.gold : ag?.c || C.textMuted,
                          fontFamily: "'Cinzel', serif", fontSize: 13, fontWeight: isCurrent ? 700 : 400,
                          letterSpacing: 1, transition: "all 0.15s",
                        }}>
                          {w.year} <span style={{fontSize:10,opacity:0.7}}>{w.quantity}bt</span>
                        </button>
                      );
                    })}
                  </div>
                )}

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
                    ...(editing.alcohol?[["🔥", `${editing.alcohol}%`]]:[]),
                    ...(editing.bottleSize && editing.bottleSize !== "0.75" ? [["📐", `${editing.bottleSize}L`]] : []),
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

                {/* Stima valore di mercato */}
                {(() => {
                  // Usa il valore salvato nel vino se presente, altrimenti quello in-memory
                  const val = estimatedValue || editing.marketValue || null;
                  return (
                <div style={{marginBottom:14}}>
                  {!val && !estimatingValue && (
                    <button onClick={()=>handleEstimateValue(editing)} style={{
                      background: C.bg, border: `1px dashed ${C.border}`, borderRadius: 9,
                      padding: "10px 16px", cursor: "pointer", width: "100%",
                      color: C.textMuted, fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1.5,
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      transition: "all 0.15s",
                    }}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textMuted;}}>
                      💰 STIMA VALORE DI MERCATO
                    </button>
                  )}
                  {estimatingValue && (
                    <div style={{background:C.bg, border:`1px solid ${C.border}`, borderRadius:9, padding:"16px", textAlign:"center"}}>
                      <div className="spinner" style={{margin:"0 auto 10px",width:22,height:22}}/>
                      <p style={{fontSize:12,color:C.textFaint,fontFamily:"'Cinzel',serif",letterSpacing:1}}>STIMA IN CORSO…</p>
                    </div>
                  )}
                  {val && !val.error && (
                    <div style={{background:C.bg, border:`1px solid rgba(212,168,90,0.4)`, borderRadius:10, padding:"14px 16px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                        <span style={{fontFamily:"'Cinzel',serif",fontSize:11,color:C.gold,letterSpacing:2,fontWeight:700}}>💰 VALORE INDICATIVO</span>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          {val.estimatedAt && (
                            <span style={{fontSize:9,color:C.textFaint,fontFamily:"'Cinzel',serif",letterSpacing:0.5}}>
                              {new Date(val.estimatedAt).toLocaleDateString("it-IT",{day:"2-digit",month:"short",year:"numeric"})}
                            </span>
                          )}
                          <span style={{
                            fontSize:10, fontFamily:"'Cinzel',serif", letterSpacing:1,
                            color: val.confidence==="alta"?"#6aaa6a":val.confidence==="media"?C.gold:"#c07070",
                            background: val.confidence==="alta"?"rgba(106,170,106,0.15)":val.confidence==="media"?"rgba(212,168,90,0.15)":"rgba(192,112,112,0.15)",
                            border: `1px solid ${val.confidence==="alta"?"rgba(106,170,106,0.4)":val.confidence==="media"?"rgba(212,168,90,0.4)":"rgba(192,112,112,0.4)"}`,
                            borderRadius:10, padding:"2px 8px",
                          }}>
                            {val.confidence==="alta"?"AFFIDABILE":val.confidence==="media"?"INDICATIVO":"APPROSSIMATIVO"}
                          </span>
                        </div>
                      </div>
                      <div style={{fontFamily:"'Cormorant Garamond',serif",fontSize:32,color:C.gold,fontWeight:300,marginBottom:6}}>
                        €{val.min}–{val.max}
                      </div>
                      {val.source && (
                        <p style={{fontSize:12,color:C.textFaint,fontStyle:"italic",margin:"0 0 6px",lineHeight:1.4}}>{val.source}</p>
                      )}
                      {val.notes && (
                        <p style={{fontSize:14,color:C.textMuted,fontFamily:"'EB Garamond',serif",lineHeight:1.55,margin:0}}>{val.notes}</p>
                      )}
                      <button onClick={()=>handleEstimateValue(editing)} style={{
                        background:"none",border:"none",color:C.textFaint,cursor:"pointer",
                        fontSize:11,fontFamily:"'Cinzel',serif",letterSpacing:1,marginTop:8,padding:0,
                      }}>🔄 RISTIMA</button>
                    </div>
                  )}
                  {val && val.error && (
                    <div style={{background:"rgba(154,80,80,0.1)", border:"1px solid rgba(154,80,80,0.3)", borderRadius:9, padding:"12px 14px", color:"#d08080", fontSize:13}}>
                      ⚠ {val.error}
                      <button onClick={()=>handleEstimateValue(editing)} style={{
                        background:"none",border:"none",color:C.gold,cursor:"pointer",
                        fontSize:12,fontFamily:"'Cinzel',serif",letterSpacing:1,marginLeft:10,
                      }}>RIPROVA</button>
                    </div>
                  )}
                </div>
                  );
                })()}

                {/* Data aggiunta */}
                {editing.addedAt && (
                  <div style={{fontSize:13,color:C.textFaint,fontFamily:"'Cinzel', serif",letterSpacing:1,marginBottom:14}}>
                    AGGIUNTO IL {new Date(editing.addedAt).toLocaleDateString("it-IT",{day:"2-digit",month:"long",year:"numeric"}).toUpperCase()}
                  </div>
                )}

                {/* ── Stato del Vino ── */}
                {(()=>{
                  const ag = getAgingStatus(editing);
                  if (!ag) return null;
                  const age = new Date().getFullYear() - editing.year;
                  const pf = editing.enrichment?.peakFrom;
                  const pt = editing.enrichment?.peakTo;
                  const hasPeak = pf != null && pt != null;
                  const apiceStart = hasPeak ? editing.year + pf : null;
                  const apiceEnd   = hasPeak ? editing.year + pt : null;
                  const yearsToApice = hasPeak ? Math.max(0, pf - age) : null;

                  // Testo invecchiamento computato dinamicamente dallo stato corrente,
                  // sempre aggiornato e coerente con la fase (non più il testo AI statico).
                  const agingDescription = (() => {
                    if (!hasPeak) {
                      if (ag.s === "Giovane") return `Questo ${editing.type || "vino"} ha ${age} ${age===1?"anno":"anni"}. Ancora giovane e in fase di sviluppo.`;
                      if (ag.s === "Apice")   return `Questo ${editing.type || "vino"} ha ${age} ${age===1?"anno":"anni"} ed è nella finestra di beva ideale.`;
                      if (ag.s === "Maturo")  return `Questo ${editing.type || "vino"} ha ${age} ${age===1?"anno":"anni"}. Maturità avanzata: consigliamo di non aspettare troppo.`;
                      return `Questo ${editing.type || "vino"} ha ${age} ${age===1?"anno":"anni"} e ha superato il periodo ottimale. Meglio aprirlo al più presto.`;
                    }
                    if (ag.s === "Giovane") return `Questo ${editing.type || "vino"} ha ${age} ${age===1?"anno":"anni"} ed è ancora in fase di sviluppo. L'apice di beva è previsto tra ${yearsToApice} ${yearsToApice===1?"anno":"anni"} (dal ${apiceStart}). Può essere goduto per la freschezza, ma regalerà complessità con la maturazione.`;
                    if (ag.s === "Apice")   return `Questo ${editing.type || "vino"} è nel pieno della finestra di beva ideale (${apiceStart}–${apiceEnd}). È il momento migliore per aprirlo: struttura, aromi terziari e equilibrio sono al loro massimo.`;
                    if (ag.s === "Maturo")  return `Questo ${editing.type || "vino"} ha superato la finestra di apice (${apiceStart}–${apiceEnd}) ed è in fase di maturità avanzata. Ancora piacevole ma con caratteristiche in evoluzione — consigliamo di non aspettare troppo.`;
                    return `Questo ${editing.type || "vino"} ha ${age} ${age===1?"anno":"anni"} e ha superato il periodo ottimale di beva (apice ${apiceStart}–${apiceEnd}). Meglio aprirlo al più presto: le caratteristiche organolettiche stanno cedendo.`;
                  })();

                  return (
                    <div style={{background:C.bg, border:`1px solid ${ag.c}44`, borderRadius:10, padding:"14px 16px", marginBottom:14}}>
                      <div style={{display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 10}}>
                        <div style={{display:"flex", alignItems:"center", gap:10}}>
                          <span style={{fontSize:28}}>
                            {ag.s==="Giovane"?"🌱":ag.s==="Apice"?"⭐":ag.s==="Maturo"?"🍂":"📉"}
                          </span>
                          <div>
                            <div style={{fontSize:20, color:ag.c, fontFamily:"'Cinzel', serif", fontWeight:700, letterSpacing:1}}>{ag.s.toUpperCase()}</div>
                            <div style={{fontSize:16, color:C.textMuted, fontFamily:"'Cinzel', serif"}}>{age} {age===1?"anno":"anni"} · {editing.type}</div>
                            {hasPeak && (
                              <div style={{fontSize:13, color:C.textFaint, fontFamily:"'Cinzel', serif", marginTop:2}}>
                                APICE: {apiceStart}–{apiceEnd}
                              </div>
                            )}
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
                      <p style={{fontSize:16, color:C.textMuted, fontFamily:"'EB Garamond', serif", lineHeight:1.65, margin:0, fontWeight:400}}>
                        {agingDescription}
                      </p>
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

                {/* Nuova annata — shortcut per aggiungere un'altra annata dello stesso vino */}
                <button onClick={()=>addNewVintage(editing)}
                  title="Crea una nuova voce con gli stessi metadati (nome, produttore, vitigno, regione) ma annata/scorte nuove"
                  style={{
                    marginTop:8, width:"100%",
                    background:"transparent", border:`1px dashed ${C.border}`, borderRadius:8,
                    color:C.textFaint, cursor:"pointer", padding:"10px 12px",
                    fontFamily:"'Cinzel', serif", fontSize:12, letterSpacing:1.5,
                    transition:"all 0.15s",
                  }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.gold;e.currentTarget.style.color=C.gold;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.textFaint;}}>
                  ＋ AGGIUNGI UN'ALTRA ANNATA DI QUESTO VINO
                </button>
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
              <div>
                <label style={labelStyle}>Casa / Posizione</label>
                <input
                  style={inputStyle}
                  value={editingRack.house || ""}
                  onChange={e=>setEditingRack(v=>({...v,house:e.target.value}))}
                  placeholder="es. Casa Milano, Casa Mare…"
                  list="houses-datalist"
                />
                <datalist id="houses-datalist">
                  {houseList.map(h => <option key={h} value={h}/>)}
                </datalist>
                <p style={{fontSize:12,color:C.textFaint,fontStyle:"italic",marginTop:6}}>
                  Se hai scaffali in più case, puoi raggrupparli così.
                </p>
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
          saveWines(wines.map(w=>w.id===dw.id?{...w,deleted:true,lastModified:Date.now()}:w));
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

      {/* ── APRI STASERA MODAL ── */}
      {tonightOpen && (
        <div className="modal-overlay" onClick={() => setTonightOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div style={{ height: 4, background: `linear-gradient(90deg, #7a2a9a, #c9953a)`, borderRadius: "14px 14px 0 0" }} />
            <div style={{ padding: "22px 22px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <div>
                  <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.gold, letterSpacing: 2 }}>
                    🍷 APRI STASERA
                  </h2>
                  <p style={{ fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginTop: 4 }}>
                    {tonightHouse ? `IN ${tonightHouse.toUpperCase()}` : "I MIEI SUGGERIMENTI"}
                  </p>
                </div>
                <button onClick={() => setTonightOpen(false)} style={{ background: "none", border: "none", color: C.textFaint, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>✕</button>
              </div>

              {/* Filtro casa — visibile solo se hai almeno 2 case distinte */}
              {houseList.length >= 2 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 14, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
                  <button onClick={() => setTonightHouse(null)} className="tab-btn" style={{
                    color: !tonightHouse ? C.gold : C.textFaint,
                    background: !tonightHouse ? "rgba(212,168,90,0.16)" : "none",
                    border: !tonightHouse ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                  }}>TUTTE LE CASE</button>
                  {houseList.map(h => (
                    <button key={h} onClick={() => setTonightHouse(h)} className="tab-btn" style={{
                      color: tonightHouse === h ? C.gold : C.textFaint,
                      background: tonightHouse === h ? "rgba(212,168,90,0.16)" : "none",
                      border: tonightHouse === h ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                    }}>🏠 {h.toUpperCase()}</button>
                  ))}
                </div>
              )}

              {tonightFilteredPicks.length === 0 ? (
                <div style={{ textAlign: "center", padding: "40px 10px", color: C.textFaint }}>
                  <div style={{ fontSize: 44, marginBottom: 10, opacity: 0.4 }}>🍷</div>
                  <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 1, fontSize: 14 }}>
                    {tonightHouse ? `NESSUN SUGGERIMENTO IN ${tonightHouse.toUpperCase()}` : "NESSUN SUGGERIMENTO URGENTE"}
                  </p>
                  <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic", marginTop: 8 }}>
                    {tonightHouse ? "Prova un'altra casa o togli il filtro." : "Tutti i tuoi vini sono tranquillamente in cantina."}
                  </p>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
                  {tonightFilteredPicks.map(({ wine, reason, aging }, idx) => {
                    const tc = typeColors[wine.type] || { bar: "#888" };
                    return (
                      <div key={wine.id}
                        onClick={() => { setTonightOpen(false); setEditing({...wine}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setEstimatedValue(null); setModal("view"); }}
                        style={{
                          background: C.surface2, border: `1px solid ${aging?.c || C.border}`, borderRadius: 10,
                          padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                          transition: "all 0.15s",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = aging?.c || C.border; }}>
                        <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%",
                          background: `${tc.bar}22`, border: `2px solid ${tc.bar}`,
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontFamily: "'Cinzel', serif", fontSize: 15, fontWeight: 700, color: tc.bar }}>{idx + 1}</div>
                        {(wine.photos || [])[0] && (
                          <img src={wine.photos[0]} alt={wine.name}
                            style={{ flexShrink: 0, width: 44, height: 56, objectFit: "cover", borderRadius: 4, border: `1px solid ${C.border}` }} />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {wine.name}
                          </div>
                          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                            {[wine.producer, wine.year].filter(Boolean).join(" · ")}
                          </div>
                          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 11, color: aging?.c || C.textFaint, letterSpacing: 0.8, marginTop: 4, fontStyle: "italic" }}>
                            {reason}
                          </div>
                        </div>
                        <div style={{ flexShrink: 0, fontSize: 18, color: C.gold }}>›</div>
                      </div>
                    );
                  })}
                </div>
              )}

              <p style={{ fontSize: 12, color: C.textFaint, fontStyle: "italic", marginTop: 16, textAlign: "center" }}>
                Basato su invecchiamento, scorte e varietà rispetto al tuo storico.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── SEARCH MODAL (full-screen) ── */}
      {searchModalOpen && (() => {
        // Risultati filtrati e raggruppati per verticale (stesso producer+name = 1 entry)
        const q = search.trim().toLowerCase();
        const searchResults = (() => {
          if (!q) return [];
          const matching = activeWines.filter(w => {
            const fields = [
              w.name || "", w.denomination || "", w.producer || "",
              w.region || "", w.grape || "", w.type || "",
              w.notes || "", w.year ? String(w.year) : "",
              ...(w.rackSlots || []).flatMap(s => s.positions || []),
            ];
            return fields.some(f => f.toLowerCase().includes(q));
          });
          // Raggruppa per verticale (come nel catalogo)
          const groups = new Map();
          matching.forEach(w => {
            const k = verticaleKey(w);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(w);
          });
          return Array.from(groups.values())
            .map(ws => ws.sort((a, b) => (b.year || 0) - (a.year || 0)))
            .slice(0, 30);
        })();
        return (
          <div className="modal-overlay" style={{ alignItems: "flex-start", padding: 0 }} onClick={() => setSearchModalOpen(false)}>
            <div className="modal-box" style={{
              maxWidth: "100%", borderRadius: 0, maxHeight: "100svh", height: "100svh",
              display: "flex", flexDirection: "column",
            }} onClick={e => e.stopPropagation()}>
              {/* Header con input autofocus */}
              <div style={{
                position: "sticky", top: 0, zIndex: 2,
                background: C.surface, borderBottom: `1px solid ${C.border}`,
                padding: "env(safe-area-inset-top, 12px) 14px 12px 14px",
                display: "flex", gap: 10, alignItems: "center",
              }}>
                <div style={{ flex: 1, position: "relative" }}>
                  <span style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: C.textFaint, fontSize: 16, pointerEvents: "none" }}>🔍</span>
                  <input
                    autoFocus
                    placeholder="Cerca vino, produttore, annata…"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    style={{
                      ...inputStyle,
                      padding: "12px 14px 12px 38px",
                      paddingRight: search ? 38 : 14,
                      fontSize: 16,
                      fontFamily: "'Cinzel', serif",
                      letterSpacing: 0.5,
                    }}
                  />
                  {search && (
                    <button onClick={() => setSearch("")} style={{
                      position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                      background: C.border, border: "none", borderRadius: "50%",
                      width: 22, height: 22, cursor: "pointer", color: C.text,
                      fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center",
                    }}>✕</button>
                  )}
                </div>
                <button onClick={() => setSearchModalOpen(false)} style={{
                  background: "none", border: "none", color: C.textMuted,
                  cursor: "pointer", fontSize: 13, fontFamily: "'Cinzel', serif", letterSpacing: 1.5, fontWeight: 700,
                  flexShrink: 0, padding: "0 4px",
                }}>FINE</button>
              </div>

              {/* Risultati raggruppati per verticale */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px 40px" }}>
                {!q ? (
                  <div style={{ textAlign: "center", padding: "60px 20px", color: C.textFaint }}>
                    <div style={{ fontSize: 40, marginBottom: 10, opacity: 0.4 }}>🔍</div>
                    <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 1.5, fontSize: 12 }}>
                      INIZIA A SCRIVERE
                    </p>
                    <p style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic", marginTop: 8, lineHeight: 1.5 }}>
                      Cerca per nome, produttore, annata, vitigno, regione, posizione scaffale o note.
                    </p>
                  </div>
                ) : searchResults.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "60px 20px", color: C.textFaint }}>
                    <p style={{ fontFamily: "'Cinzel', serif", letterSpacing: 1.5, fontSize: 12 }}>
                      NESSUN RISULTATO per "{search}"
                    </p>
                  </div>
                ) : (
                  <>
                    <p style={{ fontSize: 11, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginBottom: 10 }}>
                      {searchResults.length} {searchResults.length === 1 ? "etichetta" : "etichette"}
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {searchResults.map(group => {
                        const wine = group[0]; // rappresentativa (più recente)
                        const isGroup = group.length > 1;
                        const totalBt = group.reduce((s, w) => s + (w.quantity || 0), 0);
                        const tc = typeColors[wine.type] || { bar: "#888" };
                        return (
                          <div key={`${wine.producer}::${wine.name}`}
                            onClick={() => {
                              if (isGroup) {
                                setSearchModalOpen(false);
                                setVerticaleOpen({ key: verticaleKey(wine), wines: group });
                              } else {
                                setSearchModalOpen(false);
                                setEditing({...wine}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setEstimatedValue(null); setModal("view");
                              }
                            }}
                            style={{
                              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9,
                              padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10,
                              transition: "all 0.15s",
                            }}>
                            <div style={{ flexShrink: 0, width: 4, alignSelf: "stretch", background: tc.bar, borderRadius: 2 }} />
                            {(wine.photos || [])[0] && (
                              <img src={wine.photos[0]} alt={wine.name}
                                style={{ flexShrink: 0, width: 32, height: 42, objectFit: "cover", borderRadius: 3, border: `1px solid ${C.border}` }} />
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {wine.name}
                              </div>
                              <div style={{ fontFamily: "'Cinzel', serif", fontSize: 11, color: C.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                                {isGroup
                                  ? `${wine.producer} · ${Math.min(...group.map(w=>w.year||9999))}–${Math.max(...group.map(w=>w.year||0))}`
                                  : [wine.producer, wine.year, wine.grape].filter(Boolean).join(" · ")}
                              </div>
                            </div>
                            <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                              <span style={{ fontFamily: "'Cinzel', serif", fontSize: 11, color: totalBt === 0 ? "#c07070" : C.gold, fontWeight: 700 }}>
                                {totalBt}bt
                              </span>
                              {isGroup && (
                                <span style={{ fontSize: 10, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 0.5, opacity: 0.8 }}>
                                  {group.length} annate
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── FILTRI MODAL (bottom sheet su mobile) ── */}
      {filtersOpen && (() => {
        const sectionStyle = { marginBottom: 22 };
        const labelH = { fontSize: 11, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 2, fontWeight: 700, marginBottom: 10, display: "block" };
        const pillRow = { display: "flex", gap: 6, flexWrap: "wrap" };
        const activeCount = [
          filterType !== "Tutti",
          !!filterGrape,
          !!filterRegion,
          filterAging !== "Tutti",
          filterUnracked,
          filterUrgent,
        ].filter(Boolean).length;
        return (
          <div className="modal-overlay" onClick={() => setFiltersOpen(false)}>
            <div className="modal-box" style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
              {/* Header sticky con X */}
              <div style={{
                position: "sticky", top: 0, zIndex: 2,
                background: C.surface, borderBottom: `1px solid ${C.border}`,
                borderRadius: "16px 16px 0 0",
                padding: "16px 22px 14px",
                display: "flex", justifyContent: "space-between", alignItems: "center",
              }}>
                <div>
                  <div style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, letterSpacing: 2, fontWeight: 700 }}>
                    ⚙ FILTRI
                  </div>
                  {activeCount > 0 && (
                    <div style={{ fontSize: 12, color: C.textMuted, fontFamily: "'EB Garamond', serif", fontStyle: "italic", marginTop: 2 }}>
                      {activeCount} {activeCount === 1 ? "filtro attivo" : "filtri attivi"}
                    </div>
                  )}
                </div>
                <button onClick={() => setFiltersOpen(false)} style={{
                  background: "none", border: `1px solid ${C.border}`, color: C.textMuted,
                  cursor: "pointer", fontSize: 18, lineHeight: 1,
                  width: 36, height: 36, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>✕</button>
              </div>

              {/* Body scrollabile */}
              <div style={{ padding: "18px 22px 12px" }}>
                {/* Tipo */}
                <div style={sectionStyle}>
                  <span style={labelH}>TIPOLOGIA</span>
                  <div style={pillRow}>
                    {["Tutti", ...WINE_TYPES].map(t => (
                      <button key={t} className="tab-btn" onClick={() => setFilterType(t)} style={{
                        color: filterType === t ? C.gold : C.textFaint,
                        background: filterType === t ? "rgba(212,168,90,0.16)" : "none",
                        border: filterType === t ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                      }}>{t.toUpperCase()}</button>
                    ))}
                  </div>
                </div>

                {/* Stato invecchiamento */}
                <div style={sectionStyle}>
                  <span style={labelH}>STATO INVECCHIAMENTO</span>
                  <div style={pillRow}>
                    {[
                      { key: "Tutti",   label: "Tutti",   icon: "" },
                      { key: "Giovane", label: "Giovane", icon: "🌱" },
                      { key: "Apice",   label: "Apice",   icon: "⭐" },
                      { key: "Maturo",  label: "Maturo",  icon: "🍂" },
                      { key: "Declino", label: "Declino", icon: "📉" },
                    ].map(({ key, label, icon }) => (
                      <button key={key} className="tab-btn" onClick={() => setFilterAging(key)} style={{
                        color: filterAging === key ? C.gold : C.textFaint,
                        background: filterAging === key ? "rgba(212,168,90,0.16)" : "none",
                        border: filterAging === key ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                      }}>{icon} {label.toUpperCase()}</button>
                    ))}
                  </div>
                </div>

                {/* Vitigno (dinamico) */}
                {grapeList.length > 0 && (
                  <div style={sectionStyle}>
                    <span style={labelH}>VITIGNO</span>
                    <div style={pillRow}>
                      <button className="tab-btn" onClick={() => setFilterGrape(null)} style={{
                        color: !filterGrape ? C.gold : C.textFaint,
                        background: !filterGrape ? "rgba(212,168,90,0.16)" : "none",
                        border: !filterGrape ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                      }}>TUTTI</button>
                      {grapeList.map(g => (
                        <button key={g} className="tab-btn" onClick={() => setFilterGrape(filterGrape === g ? null : g)} style={{
                          color: filterGrape === g ? C.gold : C.textFaint,
                          background: filterGrape === g ? "rgba(212,168,90,0.16)" : "none",
                          border: filterGrape === g ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                        }}>{g.toUpperCase()}</button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Stock / Senza scaffale */}
                <div style={sectionStyle}>
                  <span style={labelH}>STOCK</span>
                  <div style={pillRow}>
                    <button className="tab-btn" onClick={() => setFilterUnracked(v => !v)} style={{
                      color: filterUnracked ? C.gold : C.textFaint,
                      background: filterUnracked ? "rgba(212,168,90,0.16)" : "none",
                      border: filterUnracked ? `1px solid rgba(212,168,90,0.45)` : `1px solid ${C.border}`,
                    }}>🗄 SENZA SCAFFALE</button>
                    <button className="tab-btn" onClick={() => setFilterUrgent(v => !v)} style={{
                      color: filterUrgent ? C.accent : C.textFaint,
                      background: filterUrgent ? "rgba(139,30,63,0.16)" : "none",
                      border: filterUrgent ? `1px solid rgba(139,30,63,0.5)` : `1px solid ${C.border}`,
                    }}>⚠ URGENTI</button>
                  </div>
                </div>

                {/* Ordinamento */}
                <div style={sectionStyle}>
                  <span style={labelH}>ORDINA PER</span>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{
                      background: C.bg, border: `1px solid ${C.border}`, borderRadius: 9,
                      color: C.text, padding: "10px 14px", width: "auto", outline: "none",
                      fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1,
                    }}>
                      <option value="name">NOME</option>
                      <option value="year">ANNATA</option>
                      <option value="quantity">QUANTITÀ</option>
                      <option value="urgency">DA BERE</option>
                    </select>
                    {sortBy === "year" && (
                      <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")} style={{
                        background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 9,
                        color: C.gold, cursor: "pointer", padding: "10px 14px",
                        fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1,
                      }}>
                        {sortDir === "asc" ? "↑ PIÙ VECCHI" : "↓ PIÙ RECENTI"}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Footer sticky con Reset + Applica */}
              <div style={{
                position: "sticky", bottom: 0, zIndex: 2,
                background: C.surface, borderTop: `1px solid ${C.border}`,
                padding: "14px 22px",
                display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center",
              }}>
                <button onClick={() => {
                  setFilterType("Tutti"); setFilterGrape(null); setFilterRegion(null);
                  setFilterAging("Tutti"); setFilterUnracked(false); setFilterUrgent(false);
                }} disabled={activeCount === 0} style={{
                  background: "transparent", border: `1px solid ${C.border}`, borderRadius: 9,
                  color: activeCount === 0 ? C.textFaint : C.textMuted,
                  cursor: activeCount === 0 ? "not-allowed" : "pointer",
                  padding: "10px 16px",
                  fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1.5, fontWeight: 700,
                  opacity: activeCount === 0 ? 0.5 : 1,
                }}>RESET</button>
                <button onClick={() => setFiltersOpen(false)} className="btn-gold" style={{ padding: "10px 22px", fontSize: 13 }}>
                  APPLICA
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── FOOD PAIRING MODAL ── */}
      {pairingOpen && (
        <div className="modal-overlay" style={{ alignItems: "center", padding: 12 }} onClick={() => setPairingOpen(false)}>
          <div className="modal-box" style={{ maxWidth: 580, maxHeight: "min(88svh, 720px)" }} onClick={e => e.stopPropagation()}>
            <div style={{ height: 4, background: `linear-gradient(90deg, #3a7a5a, #c9953a)`, borderRadius: "14px 14px 0 0" }} />
            <div style={{ padding: "22px 22px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                <div>
                  <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.gold, letterSpacing: 2 }}>
                    🍽 ABBINA A…
                  </h2>
                  <p style={{ fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif", letterSpacing: 1, marginTop: 4 }}>
                    COSA STAI MANGIANDO?
                  </p>
                </div>
                <button onClick={() => setPairingOpen(false)} style={{ background: "none", border: "none", color: C.textFaint, cursor: "pointer", fontSize: 22, lineHeight: 1 }}>✕</button>
              </div>

              <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
                <input style={{ ...inputStyle, fontSize: 16, fontFamily: "'Cinzel', serif", letterSpacing: 0.5 }}
                  placeholder="es. brasato al Barolo, pesce al forno, carbonara…"
                  value={pairingDish}
                  onChange={e => setPairingDish(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !pairingLoading) handlePairWine(); }} />
                <button onClick={handlePairWine} disabled={pairingLoading || !pairingDish.trim()} style={{
                  background: pairingLoading || !pairingDish.trim() ? C.surface2 : "linear-gradient(135deg, #1a3a2a, #3a7a5a)",
                  border: "1px solid rgba(122,186,138,0.4)",
                  borderRadius: 8, padding: "0 18px", cursor: pairingLoading || !pairingDish.trim() ? "not-allowed" : "pointer",
                  color: pairingLoading || !pairingDish.trim() ? C.textFaint : "#d0f0dc",
                  fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1, fontWeight: 700,
                  whiteSpace: "nowrap", transition: "all 0.15s", flexShrink: 0,
                }}>
                  {pairingLoading ? "…" : "ABBINA"}
                </button>
              </div>

              {pairingLoading && (
                <div style={{ textAlign: "center", padding: "30px 10px", color: C.textFaint }}>
                  <div className="spinner" style={{ margin: "0 auto 14px", width: 24, height: 24 }} />
                  <p style={{ fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1 }}>IL SOMMELIER STA PENSANDO…</p>
                </div>
              )}

              {!pairingLoading && pairingResult && pairingResult.error && (
                <div style={{ marginTop: 18, padding: "12px 14px", background: "rgba(154,80,80,0.15)", border: "1px solid rgba(154,80,80,0.4)", borderRadius: 8, color: "#d08080", fontSize: 13 }}>
                  ⚠ {pairingResult.error}
                </div>
              )}

              {!pairingLoading && pairingResult && !pairingResult.error && (
                <div style={{ marginTop: 18 }}>
                  {pairingResult.note && (
                    <p style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic", marginBottom: 14, lineHeight: 1.5 }}>
                      {pairingResult.note}
                    </p>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {(pairingResult.picks || []).map((pick, idx) => {
                      const wine = activeWines.find(w => w.id === pick.wineId);
                      if (!wine) return null;
                      const tc = typeColors[wine.type] || { bar: "#888" };
                      return (
                        <div key={wine.id}
                          onClick={() => { setPairingOpen(false); setEditing({...wine}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setEstimatedValue(null); setModal("view"); }}
                          style={{
                            background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10,
                            padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                            transition: "all 0.15s",
                          }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; }}>
                          <div style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%",
                            background: `${tc.bar}22`, border: `2px solid ${tc.bar}`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontFamily: "'Cinzel', serif", fontSize: 15, fontWeight: 700, color: tc.bar }}>{idx + 1}</div>
                          {(wine.photos || [])[0] && (
                            <img src={wine.photos[0]} alt={wine.name}
                              style={{ flexShrink: 0, width: 44, height: 56, objectFit: "cover", borderRadius: 4, border: `1px solid ${C.border}` }} />
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: "'Cinzel', serif", fontSize: 16, color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {wine.name}
                            </div>
                            <div style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                              {[wine.producer, wine.year].filter(Boolean).join(" · ")}
                            </div>
                            <div style={{ fontFamily: "'EB Garamond', serif", fontSize: 13, color: C.textMuted, marginTop: 5, lineHeight: 1.4, fontStyle: "italic" }}>
                              {pick.reason}
                            </div>
                          </div>
                          <div style={{ flexShrink: 0, fontSize: 18, color: C.gold }}>›</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {!pairingLoading && !pairingResult && (
                <p style={{ fontSize: 12, color: C.textFaint, fontStyle: "italic", marginTop: 16 }}>
                  Scrivi un piatto e lascia che Claude scelga dai tuoi vini quelli più adatti.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── VERTICALE MODAL: lista annate raggruppate ── */}
      {verticaleOpen && (
        <div className="modal-overlay" onClick={() => setVerticaleOpen(null)}>
          <div className="modal-box" style={{ maxWidth: 520 }} onClick={e => e.stopPropagation()}>
            <div style={{ height: 4, background: `linear-gradient(90deg, #c9953a, #7a2a9a)`, borderRadius: "14px 14px 0 0" }} />
            <div style={{ padding: "22px 22px 18px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 11, color: C.gold, fontFamily: "'Cinzel', serif", letterSpacing: 2, marginBottom: 4 }}>🏛 VERTICALE</div>
                  <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {verticaleOpen.wines[0]?.name}
                  </h2>
                  <p style={{ fontSize: 14, color: C.textMuted, fontStyle: "italic", marginTop: 2 }}>
                    {verticaleOpen.wines[0]?.producer} · {verticaleOpen.wines.length} annate · {verticaleOpen.wines.reduce((s,w)=>s+(w.quantity||0),0)} bt totali
                  </p>
                </div>
                <button onClick={() => setVerticaleOpen(null)} style={{ background: "none", border: "none", color: C.textFaint, cursor: "pointer", fontSize: 22, lineHeight: 1, flexShrink: 0, paddingLeft: 12 }}>✕</button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
                {verticaleOpen.wines.map(w => {
                  const ag = getAgingStatus(w);
                  const tc = typeColors[w.type] || { bar: "#888" };
                  return (
                    <div key={w.id}
                      onClick={() => {
                        setVerticaleOpen(null);
                        setEditing({...w}); setViewFromPos(null); setEnrichData(null); setEnrichError(null); setEstimatedValue(null); setModal("view");
                      }}
                      style={{
                        background: C.surface2, border: `1px solid ${ag?.c || C.border}`, borderRadius: 8,
                        padding: "10px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
                        transition: "all 0.15s",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = ag?.c || C.border; }}>
                      <div style={{ flexShrink: 0, width: 6, height: 36, background: tc.bar, borderRadius: 3 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, fontWeight: 700 }}>{w.year}</div>
                        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
                          <span style={{ fontSize: 12, color: C.textMuted, fontFamily: "'Cinzel', serif" }}>{w.quantity || 0} bt</span>
                          {ag && (
                            <span style={{ fontSize: 12, color: ag.c, fontFamily: "'Cinzel', serif", fontWeight: 600 }}>
                              {ag.s === "Giovane" ? "🌱" : ag.s === "Apice" ? "⭐" : ag.s === "Maturo" ? "🍂" : "📉"} {ag.s}
                            </span>
                          )}
                          {w.price && <span style={{ fontSize: 12, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>€{w.price}</span>}
                        </div>
                      </div>
                      <div style={{ flexShrink: 0, fontSize: 18, color: C.gold }}>›</div>
                    </div>
                  );
                })}
              </div>

              {/* Aggiungi un'altra annata alla verticale */}
              <button onClick={() => { const from = verticaleOpen.wines[0]; setVerticaleOpen(null); addNewVintage(from); }}
                style={{
                  marginTop: 14, width: "100%",
                  background: "transparent", border: `1px dashed ${C.border}`, borderRadius: 8,
                  color: C.textFaint, cursor: "pointer", padding: "10px 12px",
                  fontFamily: "'Cinzel', serif", fontSize: 12, letterSpacing: 1.5,
                  transition: "all 0.15s",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = C.gold; e.currentTarget.style.color = C.gold; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.color = C.textFaint; }}>
                ＋ AGGIUNGI UN'ALTRA ANNATA A QUESTA VERTICALE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ STORICO VIEW ══════ */}
      {view === "logview" && (
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h2 style={{ fontFamily: "'Cinzel', serif", fontSize: 18, color: C.gold, letterSpacing: 2 }}>STORICO DEGUSTAZIONI</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setLogFavOnly(v => !v)} style={{
                background: logFavOnly ? "rgba(201,149,58,0.18)" : C.surface2,
                border: `1px solid ${logFavOnly ? "rgba(201,149,58,0.5)" : C.border}`,
                borderRadius: 8, padding: "6px 12px", cursor: "pointer",
                color: logFavOnly ? C.gold : C.textFaint,
                fontFamily: "'Cinzel', serif", fontSize: 13, letterSpacing: 1,
              }}>★ PREFERITI</button>
              <span style={{ fontSize: 14, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>{log.length} {log.length===1?"bt":"bt"}</span>
            </div>
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
                .filter(entry => !logFavOnly || entry.favorite)
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
                      <div style={{ textAlign: "right", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <button onClick={e => { e.stopPropagation(); saveLog(log.map(l => l.id === entry.id ? { ...l, favorite: !l.favorite } : l)); }}
                            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0,
                              color: entry.favorite ? C.gold : C.textFaint, transition: "color 0.15s" }}
                            title={entry.favorite ? "Rimuovi dai preferiti" : "Aggiungi ai preferiti"}>
                            {entry.favorite ? "★" : "☆"}
                          </button>
                          <div style={{ fontSize: 13, color: C.textFaint, fontFamily: "'Cinzel', serif" }}>
                            {new Date(entry.date).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
                          </div>
                        </div>
                        {entry.rating > 0 && (
                          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: C.gold }}>
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

              {/* Quick tasting — slider 1-5 per dimensioni chiave */}
              <div style={{ background: C.bg, borderRadius: 9, padding: "14px 16px", border: `1px solid ${C.border}` }}>
                <p style={{ ...labelStyle, marginBottom: 12, color: C.gold }}>⚡ QUICK TASTING</p>
                {[
                  { key: "quick_aromi",       label: "Aromi (intensità)",     emoji: "👃" },
                  { key: "quick_struttura",   label: "Struttura / corpo",     emoji: "💪" },
                  { key: "quick_persistenza", label: "Persistenza al palato", emoji: "⏱" },
                ].map(({ key, label, emoji }) => {
                  const val = logEntry[key] || 0;
                  return (
                    <div key={key} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <span style={{ fontSize: 13, color: C.textMuted, fontFamily: "'EB Garamond', serif" }}>{emoji} {label}</span>
                        <div style={{ display: "flex", gap: 4 }}>
                          {[1,2,3,4,5].map(n => (
                            <button key={n} type="button"
                              onClick={() => setLogEntry(v => ({ ...v, [key]: val === n ? 0 : n }))}
                              style={{
                                width: 26, height: 26, borderRadius: "50%", cursor: "pointer",
                                background: n <= val ? "rgba(201,149,58,0.2)" : "transparent",
                                border: `1px solid ${n <= val ? C.gold : C.border}`,
                                color: n <= val ? C.gold : C.textFaint,
                                fontFamily: "'Cinzel', serif", fontSize: 11, fontWeight: 700,
                                padding: 0, lineHeight: 1, transition: "all 0.12s",
                              }}>{n}</button>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <p style={{ fontSize: 11, color: C.textFaint, fontStyle: "italic", marginTop: 4 }}>
                  Valutazione rapida. Compila la scheda AIS sotto per maggior dettaglio.
                </p>
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
                      saveWines(wines.map(w => w.id === wine.id ? { ...w, deleted: true, lastModified: Date.now() } : w));
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
                        saveWines(wines.map(w => w.id === wine.id ? { ...w, deleted: true, lastModified: Date.now() } : w));
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
        <div style={{position:"fixed",inset:0,background:"rgba(24,11,16,0.94)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",zIndex:400,backdropFilter:"blur(10px)",WebkitBackdropFilter:"blur(10px)"}}>
          {/* Wordmark di caricamento */}
          <div style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 44, fontWeight: 300, letterSpacing: 14,
            background: `linear-gradient(180deg, ${C.goldLight}, ${C.gold} 60%, #8a6828)`,
            WebkitBackgroundClip: "text", backgroundClip: "text",
            WebkitTextFillColor: "transparent",
            paddingLeft: 14, marginBottom: 6,
          }}>Vinario</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 32 }}>
            <div style={{ height: 1, width: 60, background: `linear-gradient(90deg, transparent, ${C.gold})` }}/>
            <div style={{ width: 5, height: 5, borderRadius: "50%", background: C.goldLight }}/>
            <div style={{ height: 1, width: 60, background: `linear-gradient(90deg, ${C.gold}, transparent)` }}/>
          </div>
          <div style={{width:40,height:40,border:`2px solid ${C.gold}33`,borderTopColor:C.gold,borderRadius:"50%",animation:"spin 0.9s linear infinite",marginBottom:16}}/>
          <p style={{fontFamily:"'Cinzel', serif",color:C.gold,fontSize:11,letterSpacing:3,opacity:0.8}}>SINCRONIZZAZIONE</p>
        </div>
      )}
      {/* ── FAB AGGIUNGI VINO — visibile SOLO sul catalogo e solo se nessun overlay e' aperto ── */}
      {(() => {
        const anyOverlayOpen = !!(
          modal || rackModal || filtersOpen || searchModalOpen || pairingOpen ||
          tonightOpen || verticaleOpen || logModal || deleteConfirm ||
          deleteRackConfirm || drinkModal || lightboxPhoto
        );
        if (anyOverlayOpen || view !== "catalog") return null;
        return (
      <button
        onClick={() => { setEditing(emptyWine()); setScanError(null); setModal("add"); }}
        title="Aggiungi vino"
        style={{
          position: "fixed", bottom: 28, right: 24, zIndex: 300,
          width: 60, height: 60, borderRadius: "50%",
          background: `radial-gradient(circle at 35% 30%, ${C.goldLight}, ${C.gold} 55%, #7a5a22 100%)`,
          border: `1px solid ${C.goldLight}`, color: "#1a0800",
          fontSize: 32, lineHeight: 1, fontWeight: 300, fontFamily: "'Cormorant Garamond', serif",
          boxShadow: `0 6px 24px rgba(0,0,0,0.55), 0 0 0 4px ${C.bg}, 0 0 0 5px ${C.gold}55`,
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
          transition: "transform 0.15s, box-shadow 0.2s",
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.06)"; }}
        onMouseLeave={e => { e.currentTarget.style.transform = ""; }}
      >+</button>
        );
      })()}
    </div>
  );
}
