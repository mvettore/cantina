/**
 * Netlify Function: data
 * Database: Supabase (Postgres)
 *
 * GET  /.netlify/functions/data         → { wines, racks, log }
 * POST /.netlify/functions/data         → salva { wines?, racks?, log? }
 *
 * NOTA IMPORTANTE: rimuove i campi `photos` e `photo` dai vini sia in
 * lettura che in scrittura. Le foto vivono in chiavi localStorage separate
 * sul client (`cantina-photo-{id}`) e NON devono finire su Supabase: le
 * response Lambda hanno un hard limit di 6MB che viene facilmente superato
 * se anche solo alcuni vini hanno immagini base64 embedded.
 */

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

      // Logging utile per capire il dimensionamento dopo il fix
      if (winesRaw) {
        const before = estimateSize(winesRaw);
        const after  = estimateSize(wines);
        console.log(`[data GET] wines: ${before} bytes raw → ${after} bytes stripped (${wines.length} vini)`);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ wines, racks, log: logData }) };
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
