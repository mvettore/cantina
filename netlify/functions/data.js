/**
 * Netlify Function: data
 * 
 * Gestisce il salvataggio e il caricamento dei dati della cantina
 * usando Netlify Blobs come database cloud.
 * 
 * GET  /api/data  → restituisce { wines, racks }
 * POST /api/data  → salva { wines?, racks? } e restituisce { ok: true }
 */

const { getStore } = require("@netlify/blobs");

const STORE_NAME = "cantina-data";

const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Preleva il blob store
  const store = getStore(STORE_NAME);

  // ── GET: carica tutti i dati ──
  if (event.httpMethod === "GET") {
    try {
      const [winesRaw, racksRaw] = await Promise.all([
        store.get("wines"),
        store.get("racks"),
      ]);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          wines: winesRaw ? JSON.parse(winesRaw) : null,
          racks: racksRaw ? JSON.parse(racksRaw) : null,
        }),
      };
    } catch (err) {
      console.error("GET error:", err.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── POST: salva i dati ──
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const ops = [];
      if (body.wines !== undefined) ops.push(store.set("wines", JSON.stringify(body.wines)));
      if (body.racks !== undefined) ops.push(store.set("racks",  JSON.stringify(body.racks)));
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
