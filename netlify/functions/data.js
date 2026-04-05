const handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Supabase non configurato" }) };
  }

  const apiBase = `${SUPABASE_URL}/rest/v1/cantina_data`;
  const sbHeaders = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Prefer": "return=representation",
  };

  if (event.httpMethod === "GET") {
    try {
      const r = await fetch(`${apiBase}?select=key,value`, { headers: sbHeaders });
      const rows = await r.json();
      if (!Array.isArray(rows)) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Errore DB", detail: rows }) };
      }
      const wines = rows.find(r => r.key === "wines")?.value ?? null;
      const racks = rows.find(r => r.key === "racks")?.value ?? null;
      return { statusCode: 200, headers, body: JSON.stringify({ wines, racks }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body || "{}");
      const ops = [];
      for (const [key, value] of Object.entries(body)) {
        if (key !== "wines" && key !== "racks") continue;
        ops.push(fetch(`${apiBase}`, {
          method: "POST",
          headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ key, value }),
        }));
      }
      await Promise.all(ops);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };
};

module.exports = { handler };
