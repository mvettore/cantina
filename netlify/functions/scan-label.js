/**
 * Netlify Function: scan-label
 * OCR etichetta vino (fronte + retro opzionale) → JSON strutturato.
 * Provider AI: Gemini (default, free tier) con fallback su Anthropic.
 */

const { callAI, parseJSONResponse, activeProvider } = require("./_ai");

const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  if (activeProvider() === "none") {
    return { statusCode: 500, body: JSON.stringify({ error: "Nessuna API key configurata (GEMINI_API_KEY o ANTHROPIC_API_KEY)" }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) }; }

  const { base64, mediaType, base64_2, mediaType_2 } = body;
  if (!base64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti" }) };

  console.log(`[${activeProvider()}] scan-label: ~${Math.round(base64.length * 0.75 / 1024)}KB`);

  const hasSecond = !!(base64_2 && mediaType_2);
  const prompt = `Sei un esperto di vini. Leggi quest${hasSecond ? "e etichette" : "a etichetta"} di vino (${hasSecond ? "fronte e retro" : "fronte"}) e restituisci SOLO questo JSON (niente altro testo):
{
  "name": "nome commerciale del vino",
  "producer": "nome cantina o produttore",
  "year": 2019,
  "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito",
  "region": "regione italiana o paese",
  "grape": "vitigno principale",
  "notes": "1-2 frasi descrittive",
  "price": null
}
Usa null per i campi non leggibili.`;

  const images = [{ base64, mediaType }];
  if (hasSecond) images.push({ base64: base64_2, mediaType: mediaType_2 });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const raw = await callAI({
      prompt,
      maxTokens: 500,
      temperature: 0.3,
      images,
      jsonMode: true,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    // Valida che sia JSON parseabile (gli altri endpoint lo fanno sempre;
    // qui il frontend si aspetta il body = JSON string, non oggetto — conservativo)
    const parsed = parseJSONResponse(raw);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") return { statusCode: 504, body: JSON.stringify({ error: "Timeout" }) };
    return { statusCode: err.status || 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
