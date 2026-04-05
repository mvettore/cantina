/**
 * Netlify Function: scan-label
 * Usa claude-haiku (più veloce) per leggere l'etichetta — risponde in 2-4s.
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
    return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key non configurata" }) };
  }

  console.log(`Immagine ricevuta: ~${Math.round(base64.length * 0.75 / 1024)}KB`);

  const prompt = `Leggi questa etichetta di vino e restituisci SOLO un oggetto JSON valido:
{
  "name": "nome commerciale del vino (non il produttore)",
  "producer": "cantina o produttore",
  "year": 2019,
  "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito",
  "region": "regione italiana o paese",
  "grape": "vitigno principale",
  "notes": "1-2 frasi descrittive",
  "price": null
}
Usa null per i campi non leggibili. Niente testo fuori dal JSON.`;

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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
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
      console.error("API error:", response.status, errText);
      return { statusCode: response.status, body: JSON.stringify({ error: errText }) };
    }

    const data = await response.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    console.log("Risposta raw:", raw.slice(0, 200));

    const clean = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
    const parsed = JSON.parse(clean);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.error("Timeout 24s");
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout — riprova" }) };
    }
    console.error("Errore:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
