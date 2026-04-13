/**
 * Netlify Function: estimate-value
 * Stima il valore di mercato indicativo di una bottiglia di vino
 * basandosi su nome, produttore, annata, tipologia e regione.
 * Provider AI: Gemini (default) con fallback su Anthropic.
 */

const { callAI, parseJSONResponse, activeProvider } = require("./_ai");

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (activeProvider() === "none") {
    return { statusCode: 500, body: JSON.stringify({ error: "Nessuna API key configurata" }) };
  }

  let wine;
  try {
    wine = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const prompt = `Sei un esperto del mercato del vino italiano e internazionale. Stima il valore di mercato indicativo di questa bottiglia:

Nome: ${wine.name || "—"}
Produttore: ${wine.producer || "—"}
Annata: ${wine.year || "—"}
Tipologia: ${wine.type || "—"}
Regione: ${wine.region || "—"}
Vitigno: ${wine.grape || "—"}
Gradazione: ${wine.alcohol ? wine.alcohol + "%" : "—"}

Basa la tua stima su:
- Prezzi tipici in enoteca e online (Wine-Searcher, Tannico, Callmewine, Vivino) per questo specifico vino e annata
- La reputazione del produttore
- L'annata (annate eccellenti valgono di più)
- La rarità e la disponibilità sul mercato
- Se il vino è molto comune (< €15) o un "cult wine" (> €200)

Se non conosci il vino specifico, stima in base a produttore, denominazione e regione simili. Se davvero non hai elementi, indicalo nella nota e dai un range ampio.

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido:
{
  "min": <prezzo minimo stimato in euro, intero>,
  "max": <prezzo massimo stimato in euro, intero>,
  "confidence": "alta|media|bassa",
  "source": "una frase breve su come hai stimato (es. 'Prezzo enoteca tipico per Barolo DOCG di questo produttore')",
  "notes": "1-2 frasi di contesto: perché questo range, se l'annata è particolarmente buona/cattiva, se il vino è raro o comune"
}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const raw = await callAI({
      prompt,
      maxTokens: 600,
      temperature: 0.4,
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
