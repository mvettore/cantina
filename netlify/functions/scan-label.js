/**
 * Netlify Function: scan-label
 * Riceve l'immagine in base64, chiama Anthropic Vision, restituisce JSON del vino.
 * Timeout esplicito a 24s per stare dentro il limite Netlify di 26s.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const { base64, mediaType } = body;
  if (!base64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti: base64, mediaType" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY non configurata" }) };
  }

  const prompt = `Sei un esperto enologo. Analizza questa etichetta di vino.
Restituisci ESCLUSIVAMENTE un oggetto JSON valido (niente testo prima o dopo) con questi campi:
{
  "name": "nome commerciale del vino",
  "producer": "nome della cantina/produttore",
  "year": 2019,
  "type": "uno tra: Rosso, Bianco, Rosato, Spumante, Dolce, Passito",
  "region": "regione italiana o paese",
  "grape": "vitigno principale",
  "notes": "2-3 frasi descrittive sul vino",
  "price": null
}
Se un campo non è determinabile usa null. Deduci il tipo dal vitigno o dalla denominazione.`;

  // Timeout esplicito a 24 secondi (il limite Netlify è 26s)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Anthropic error ${response.status}: ${errText}` }),
      };
    }

    const data = await response.json();
    console.log("Stop reason:", data.stop_reason);

    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const raw = textBlocks.map(b => b.text).join("").trim();
    console.log("Raw (first 300):", raw.slice(0, 300));

    const clean = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(clean);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.error("Timeout: Anthropic non ha risposto in 24s");
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout: riprova con una foto più piccola" }) };
    }
    console.error("Errore:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
