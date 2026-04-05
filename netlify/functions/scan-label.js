/**
 * Netlify Function: scan-label
 * Legge l'etichetta E restituisce le coordinate di ritaglio in un'unica chiamata.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) }; }

  const { base64, mediaType } = body;
  if (!base64 || !mediaType) {
    return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "API key non configurata" }) };

  console.log(`Immagine: ~${Math.round(base64.length * 0.75 / 1024)}KB`);

  const prompt = `Analizza questa fotografia di una bottiglia di vino.

Restituisci SOLO un oggetto JSON valido con questi campi:
{
  "name": "nome commerciale del vino (non il produttore)",
  "producer": "cantina o produttore",
  "year": 2019,
  "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito",
  "region": "regione italiana o paese",
  "grape": "vitigno principale",
  "notes": "1-2 frasi descrittive",
  "price": null,
  "crop": { "x": 10, "y": 5, "w": 80, "h": 60 }
}

Il campo "crop" deve contenere le coordinate percentuali (0-100) del rettangolo che contiene SOLO l'etichetta nella foto (non la bottiglia intera). x,y = angolo superiore sinistro, w,h = larghezza e altezza.
Usa null per i campi del vino non leggibili. Niente testo fuori dal JSON.`;

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
        max_tokens: 600,
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
    console.log("Raw:", raw.slice(0, 300));

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
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout — riprova" }) };
    }
    console.error("Errore:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
