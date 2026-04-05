const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) }; }

  const { base64, mediaType } = body;
  if (!base64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti" }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "API key mancante" }) };

  console.log(`Immagine ricevuta: ~${Math.round(base64.length * 0.75 / 1024)}KB`);

  const prompt = `Sei un esperto di vini. Analizza questa immagine di una bottiglia di vino.

Restituisci SOLO un JSON con questi campi esatti (niente altro testo):
{
  "name": "nome commerciale del vino",
  "producer": "nome cantina o produttore",
  "year": 2019,
  "type": "Rosso|Bianco|Rosato|Spumante|Dolce|Passito",
  "region": "regione italiana o paese estero",
  "grape": "vitigno principale",
  "notes": "breve descrizione",
  "price": null,
  "crop": {
    "x": 15,
    "y": 20,
    "w": 70,
    "h": 45
  }
}

Per il campo "crop": indica le coordinate percentuali (0-100) del rettangolo che racchiude SOLO l'etichetta cartacea del vino nell'immagine, escludendo la bottiglia, il tappo, le mani e lo sfondo. x e y sono l'angolo superiore sinistro. w è la larghezza. h è l'altezza. Sii preciso.

Usa null per i campi del vino non leggibili.`;

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
        max_tokens: 700,
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
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    console.log("Risposta:", raw.slice(0, 400));

    const clean = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
    const parsed = JSON.parse(clean);
    console.log("Crop:", JSON.stringify(parsed.crop));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") return { statusCode: 504, body: JSON.stringify({ error: "Timeout" }) };
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
