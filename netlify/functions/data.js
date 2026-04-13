/**
 * Netlify Function: data
 * Database: Supabase (Postgres)
 *
 * GET  /.netlify/functions/data         → { wines, racks, log }
 *   Supporta HTTP ETag + If-None-Match per sync differenziale:
 *   se il client manda If-None-Match con l'etag corrente, il server
 *   risponde 304 Not Modified con body vuoto, risparmiando la
 *   serializzazione/parsing sul frontend.
 * POST /.netlify/functions/data         → salva { wines?, racks?, log? }
 *
 * NOTA IMPORTANTE: rimuove i campi `photos` e `photo` dai vini sia in
 * lettura che in scrittura. Le foto vivono su Supabase Storage, i
 * metadati qui contengono solo gli URL.
 */

const crypto = require("crypto");

// Calcola un ETag dal body (SHA-1 troncato a 16 char). Deterministico,
// quindi stesso contenuto = stesso ETag.
function computeEtag(bodyString) {
  return `"${crypto.createHash("sha1").update(bodyString).digest("hex").substring(0, 16)}"`;
}

// Filtra selettivamente le foto dai vini:
// - URL http/https (es. Supabase Storage) → mantenuti (piccoli, sincronizzabili)
// - data URL base64                        → rimossi (troppo grandi, causano 413)
// - Campo `photo` singolo legacy           → rimosso sempre
// Resiste a input non-array o oggetti malformati.
function stripPhotosFromWines(wines) {
  if (!Array.isArray(wines)) return wines;
  return wines.map(w => {
    if (!w || typeof w !== "object") return w;
    const { photo, photos, ...rest } = w; // scarta sempre il campo `photo` legacy
    let cleanPhotos = photos;
    if (Array.isArray(cleanPhotos)) {
      cleanPhotos = cleanPhotos.filter(
        p => typeof p === "string" && (p.startsWith("http://") || p.startsWith("https://"))
      );
    } else {
      cleanPhotos = [];
    }
    return { ...rest, photos: cleanPhotos };
  });
}

// Stima dimensione del payload in byte dopo il JSON.stringify (per logging)
function estimateSize(obj) {
  try { return JSON.stringify(obj).length; } catch { return -1; }
}

const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const SUPABASE_URL   = process.env.SUPABASE_URL;
  const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Supabase non configurato" }) };
  }

  // Separa i dati per ambiente: production usa chiavi semplici, staging le prefissa
  const host = event.headers?.host || event.headers?.Host || "";
  const keyPrefix = host.includes("staging--") ? "staging:" : "";

  const apiBase = `${SUPABASE_URL}/rest/v1/cantina_data`;
  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Prefer": "return=representation",
  };

  // ── GET ──
  if (event.httpMethod === "GET") {
    try {
      const r = await fetch(`${apiBase}?select=key,value`, { headers: sbHeaders });
      const rows = await r.json();
      if (!Array.isArray(rows)) {
        console.error("Supabase GET error:", rows);
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Errore lettura DB", detail: rows }) };
      }
      const winesRaw = rows.find(r => r.key === `${keyPrefix}wines`)?.value ?? null;
      const racks    = rows.find(r => r.key === `${keyPrefix}racks`)?.value ?? null;
      const logData  = rows.find(r => r.key === `${keyPrefix}log`)?.value   ?? null;

      // Strip foto dai vini prima di inviarli: evita di superare il limite 6MB
      const wines = stripPhotosFromWines(winesRaw);

      // Serializza e calcola ETag
      const body = JSON.stringify({ wines, racks, log: logData });
      const etag = computeEtag(body);

      // ── Short-circuit 304 Not Modified ──
      // Il client invia l'ultimo ETag visto in `If-None-Match`. Se combacia
      // con quello che gli servirebbe ora, rispondiamo 304 con body vuoto.
      // Cosi il client salta parsing, merge e re-render.
      const clientEtag = event.headers?.["if-none-match"] || event.headers?.["If-None-Match"];
      if (clientEtag && clientEtag === etag) {
        console.log(`[data GET] 304 Not Modified (etag ${etag.substring(0, 8)}…)`);
        return { statusCode: 304, headers: { ...headers, ETag: etag, "Cache-Control": "no-cache" }, body: "" };
      }

      // Logging dimensionamento
      if (winesRaw) {
        const before = estimateSize(winesRaw);
        const after  = estimateSize(wines);
        console.log(`[data GET] 200 ${body.length} bytes (wines: ${before}→${after}, etag ${etag.substring(0, 8)}…)`);
      }

      return {
        statusCode: 200,
        headers: { ...headers, ETag: etag, "Cache-Control": "no-cache" },
        body,
      };
    } catch (err) {
      console.error("GET error:", err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST ──
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const ops = [];

      for (const [key, value] of Object.entries(body)) {
        if (key !== "wines" && key !== "racks" && key !== "log") continue;

        // Strip foto anche in scrittura: impedisce che il cloud si bloatazzi
        // anche se il client (vecchie versioni cached) manda wines con photos embedded
        const storedValue = key === "wines" ? stripPhotosFromWines(value) : value;

        if (key === "wines" && Array.isArray(value)) {
          console.log(`[data POST] wines: ${value.length} vini (${estimateSize(storedValue)} bytes dopo strip)`);
        }

        // upsert: inserisce o aggiorna la riga con quella key (prefissata per ambiente)
        ops.push(
          fetch(`${apiBase}`, {
            method: "POST",
            headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ key: `${keyPrefix}${key}`, value: storedValue }),
          })
        );
      }

      await Promise.all(ops);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      console.error("POST error:", err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
};

module.exports = { handler };
