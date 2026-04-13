const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) }; }

  const { base64, mediaType, base64_2, mediaType_2 } = body;
  if (!base64 || !mediaType) return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti" }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "API key mancante" }) };

  console.log(`Immagine: ~${Math.round(base64.length * 0.75 / 1024)}KB`);

  const hasSecond = !!(base64_2 && mediaType_2);
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
            ...(hasSecond ? [{ type: "image", source: { type: "base64", media_type: mediaType_2, data: base64_2 } }] : []),
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
    const raw = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    const clean = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/```\s*$/i,"").trim();
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: clean };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") return { statusCode: 504, body: JSON.stringify({ error: "Timeout" }) };
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
