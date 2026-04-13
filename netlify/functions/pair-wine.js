/**
 * Netlify Function: pair-wine
 * Riceve un pasto/piatto + il catalogo vini dell'utente e restituisce:
 * - "picks": fino a 3 vini dalla cantina dell'utente
 * - "ideal": 1-2 abbinamenti ideali con vini che l'utente NON ha
 * Provider AI: Gemini (default, free tier) con fallback su Anthropic.
 */

const { callAI, parseJSONResponse, activeProvider } = require("./_ai");

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (activeProvider() === "none") {
    return { statusCode: 500, body: JSON.stringify({ error: "Nessuna API key configurata" }) };
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

  const hasCellar = catalog.length > 0;

  const prompt = `Sei un sommelier esperto. L'utente vuole abbinare un vino al seguente piatto/pasto:

PIATTO: ${dish}

${hasCellar ? `Questi sono i vini disponibili NELLA SUA CANTINA (scegli SOLO tra questi per i "picks", usando gli id esatti):
${JSON.stringify(catalog, null, 2)}

Seleziona al massimo 3 vini dalla lista sopra che abbinano meglio a questo piatto. Motiva ogni scelta in 1-2 frasi.` : "L'utente non ha vini disponibili nella posizione attuale."}

INOLTRE, suggerisci 1-2 vini IDEALI per questo piatto che l'utente potrebbe NON avere in cantina. Questi sono suggerimenti di acquisto: indica nome specifico del vino o almeno tipologia/denominazione/vitigno ideale con un range di prezzo indicativo.

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido (nessun testo fuori dal JSON):
{
  "picks": [
    { "wineId": <id numerico dal catalogo>, "reason": "motivazione 1-2 frasi" }
  ],
  "ideal": [
    { "name": "nome vino o denominazione ideale", "type": "Rosso|Bianco|etc", "grape": "vitigno", "region": "regione", "priceRange": "€X–€Y", "reason": "perché è l'abbinamento perfetto" }
  ],
  "note": "eventuale nota generale breve, opzionale"
}
${!hasCellar ? 'Il campo "picks" deve essere un array vuoto [] se non ci sono vini in cantina.' : ""}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const raw = await callAI({
      prompt,
      maxTokens: 1200,
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
