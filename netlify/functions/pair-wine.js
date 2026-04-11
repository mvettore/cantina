/**
 * Netlify Function: pair-wine
 * Riceve un pasto/piatto + il catalogo vini dell'utente e restituisce
 * fino a 3 suggerimenti motivati scelti tra le bottiglie disponibili.
 * Provider AI: Gemini (default, free tier) con fallback su Anthropic.
 */

const { callAI, parseJSONResponse, activeProvider } = require("./_ai");

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (activeProvider() === "none") {
    return { statusCode: 500, body: JSON.stringify({ error: "Nessuna API key configurata (GEMINI_API_KEY o ANTHROPIC_API_KEY)" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const dish = (body.dish || "").trim();
  const wines = Array.isArray(body.wines) ? body.wines : [];
  if (!dish) return { statusCode: 400, body: JSON.stringify({ error: "Piatto mancante" }) };
  if (wines.length === 0) return { statusCode: 400, body: JSON.stringify({ error: "Nessun vino in catalogo" }) };

  // Riassume il catalogo in forma compatta per il prompt
  const catalog = wines.slice(0, 120).map(w => ({
    id: w.id,
    name: w.name,
    producer: w.producer,
    year: w.year,
    type: w.type,
    region: w.region,
    grape: w.grape,
    pairing: w.foodPairing || "",
  }));

  const prompt = `Sei un sommelier esperto. L'utente vuole abbinare un vino al seguente piatto/pasto:

PIATTO: ${dish}

Questi sono i vini disponibili NELLA SUA CANTINA (scegli SOLO tra questi, usando gli id esatti):
${JSON.stringify(catalog, null, 2)}

Seleziona al massimo 3 vini dalla lista sopra che abbinano meglio a questo piatto. Motiva ogni scelta in 1-2 frasi, basandoti sul tipo di vino, sul vitigno, sulla regione e sugli abbinamenti tipici. Se nessuno dei vini è davvero adatto, restituisci comunque le 2-3 scelte meno cattive con una nota esplicativa.

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido (nessun testo fuori dal JSON):
{
  "picks": [
    { "wineId": <id numerico come nel catalogo>, "reason": "motivazione 1-2 frasi" }
  ],
  "note": "eventuale nota generale breve, opzionale"
}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const raw = await callAI({
      prompt,
      maxTokens: 1000,
      temperature: 0.6,
      jsonMode: true,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const parsed = parseJSONResponse(raw);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout" }) };
    }
    return { statusCode: err.status || 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
