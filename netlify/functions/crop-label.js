/**
 * Netlify Function: crop-label
 * Chiede a Claude le coordinate dell'etichetta nell'immagine.
 * Restituisce { x, y, w, h } come percentuali dell'immagine.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "No API key" }) };

  let body;
  try { body = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const { base64, mediaType } = body;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

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
        max_tokens: 100,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: `Individua il rettangolo che contiene solo l'etichetta del vino in questa immagine.
Restituisci SOLO un JSON con le coordinate come percentuali (0-100) dell'immagine:
{"x": 10, "y": 5, "w": 80, "h": 60}
Dove x,y sono l'angolo in alto a sinistra e w,h la larghezza e altezza. Niente altro testo.` }
          ],
        }],
      }),
    });

    clearTimeout(timeoutId);
    if (!response.ok) return { statusCode: response.status, body: JSON.stringify({ error: "API error" }) };

    const data = await response.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const clean = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
    const coords = JSON.parse(clean);

    // Sanity check
    if (typeof coords.x !== "number" || typeof coords.y !== "number") throw new Error("Invalid coords");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(coords),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("crop-label error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
