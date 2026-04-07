/**
 * Netlify Function: data
 * Database: Supabase (Postgres)
 *
 * GET  /.netlify/functions/data         → { wines, racks }
 * POST /.netlify/functions/data         → salva { wines?, racks? }
 */

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

  // Separa i dati per ambiente: production usa chiavi semplici, gli altri branch le prefissano
  const context = process.env.CONTEXT || "production";
  const branch  = process.env.BRANCH  || "main";
  const keyPrefix = context === "production" ? "" : `${branch}:`;

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
      const wines = rows.find(r => r.key === `${keyPrefix}wines`)?.value ?? null;
      const racks = rows.find(r => r.key === `${keyPrefix}racks`)?.value ?? null;
      const logData = rows.find(r => r.key === `${keyPrefix}log`)?.value ?? null;
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
        // upsert: inserisce o aggiorna la riga con quella key (prefissata per ambiente)
        ops.push(
          fetch(`${apiBase}`, {
            method: "POST",
            headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ key: `${keyPrefix}${key}`, value }),
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
