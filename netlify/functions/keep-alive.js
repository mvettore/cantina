/**
 * Netlify Scheduled Function: keep-alive
 * Esegue un ping a Supabase ogni 3 giorni per evitare
 * che il progetto venga messo in pausa per inattività.
 */

const handler = async () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    console.error("[keep-alive] Variabili SUPABASE_URL o SUPABASE_SERVICE_KEY mancanti");
    return { statusCode: 500 };
  }

  try {
    const resp = await fetch(`${url}/rest/v1/cantina_data?limit=1`, {
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
      },
    });
    console.log(`[keep-alive] Supabase ping OK: ${resp.status}`);
    return { statusCode: 200 };
  } catch (err) {
    console.error("[keep-alive] Errore:", err.message);
    return { statusCode: 500 };
  }
};

module.exports = { handler };
