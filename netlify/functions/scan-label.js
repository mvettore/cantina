/**
 * Netlify Function: scan-label
 * Legge una o due foto di etichette di vino (fronte/retro) e restituisce
 * i dati strutturati del vino.
 * Provider AI: Gemini (default) con fallback su Anthropic — via _ai.js.
 */

const { callAI, parseJSONResponse, activeProvider } = require("./_ai");

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (activeProvider() === "none") {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Nessuna API key configurata (GEMINI_API_KEY o ANTHROPIC_API_KEY)" }),
    };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) }; }

  const { base64, mediaType, base64_2, mediaType_2 } = body;
  if (!base64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti" }) };
  }

  const images = [{ base64, mediaType }];
  if (base64_2 && mediaType_2) images.push({ base64: base64_2, mediaType: mediaType_2 });

  const hasSecond = images.length > 1;
  console.log(`[scan-label] provider=${activeProvider()} immagini=${images.length} ~${Math.round(base64.length * 0.75 / 1024)}KB`);

  const prompt = `Sei un esperto di vini. Leggi quest${hasSecond ? "e etichette" : "a etichetta"} di vino (${hasSecond ? "fronte e retro" : "fronte"}) e restituisci SOLO questo JSON (niente altro testo):
{
  "name": "nome commerciale del vino",
  "producer": "nome cantina o produttore",
  "year": 2019,
  "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito",
  "region": "regione italiana o paese",
  "grape": "vitigno principale",
  "denomination": "denominazione e tipologia completa",
  "alcohol": 14.5,
  "notes": "1-2 frasi descrittive",
  "price": null
}
Il campo "alcohol" è la gradazione alcolica in %vol (numero decimale).
Il campo "denomination" è la denominazione ufficiale e la tipologia del vino, ad esempio "Barolo DOCG", "Barbera d'Asti Superiore DOCG", "Chianti Classico Riserva DOCG", "Langhe Nebbiolo DOC", "Prosecco di Valdobbiadene Superiore DOCG Brut". Includi sempre la sigla (DOCG, DOC, IGT) se presente sull'etichetta, e la tipologia (Riserva, Superiore, Gran Selezione, Brut, ecc.) quando indicata.
Usa null per i campi non leggibili.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const raw = await callAI({
      prompt,
      maxTokens: 600,
      images,
      temperature: 0.2,
      jsonMode: true,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const parsed = parseJSONResponse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { statusCode: 502, body: JSON.stringify({ error: "Risposta AI non valida" }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[scan-label] errore: ${err.message}`);
    if (err.name === "AbortError") {
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout: riprova con una foto più piccola" }) };
    }
    return { statusCode: err.status || 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
