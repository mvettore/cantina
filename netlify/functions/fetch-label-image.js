/**
 * Netlify Function: fetch-label-image
 * Usa Claude con web_search per trovare l'immagine dell'etichetta di un vino
 * e la restituisce come base64 data URL.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) }; }

  const { name, producer, year } = body;
  if (!name) return { statusCode: 400, body: JSON.stringify({ error: "Nome vino mancante" }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, body: JSON.stringify({ error: "API key mancante" }) };

  const wineDesc = [name, producer, year].filter(Boolean).join(" ");
  console.log(`Cerca foto per: ${wineDesc}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    // Step 1: usa Claude + web_search per trovare l'URL diretto dell'immagine
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Cerca su internet l'immagine dell'etichetta del vino: "${wineDesc}".
Cerca su Vivino, siti di enoteca online, o il sito ufficiale del produttore.
Trova l'URL diretto a un file immagine (JPG, JPEG, PNG o WEBP) della bottiglia o dell'etichetta.
Restituisci SOLO questo JSON (nient'altro, nessun testo aggiuntivo):
{"imageUrl": "https://esempio.com/immagine.jpg"}
oppure {"imageUrl": null} se non trovi un URL diretto affidabile.`,
        }],
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();
    const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    console.log("Risposta Claude:", rawText.slice(0, 300));

    // Estrai il JSON dalla risposta
    const jsonMatch = rawText.match(/\{[^{}]*"imageUrl"[^{}]*\}/);
    if (!jsonMatch) {
      return { statusCode: 404, body: JSON.stringify({ error: "Nessuna immagine trovata" }) };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const imageUrl = parsed.imageUrl;

    if (!imageUrl) {
      return { statusCode: 404, body: JSON.stringify({ error: "Nessuna immagine trovata per questo vino" }) };
    }

    console.log("URL immagine trovato:", imageUrl);

    // Step 2: scarica l'immagine e restituisci come base64
    const imgController = new AbortController();
    const imgTimeout = setTimeout(() => imgController.abort(), 8000);

    const imgResp = await fetch(imageUrl, {
      signal: imgController.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": new URL(imageUrl).origin,
      },
    });
    clearTimeout(imgTimeout);

    if (!imgResp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Impossibile scaricare l'immagine trovata" }) };
    }

    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return { statusCode: 502, body: JSON.stringify({ error: "L'URL trovato non è un'immagine" }) };
    }

    const arrayBuffer = await imgResp.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = contentType.split(";")[0].trim();
    const dataUrl = `data:${mimeType};base64,${base64}`;

    console.log(`Immagine scaricata: ~${Math.round(arrayBuffer.byteLength / 1024)}KB`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    };

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") return { statusCode: 504, body: JSON.stringify({ error: "Timeout nella ricerca" }) };
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
