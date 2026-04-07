/**
 * Netlify Function: fetch-label-image
 * Strategia a due passi:
 * 1. Claude + web_search trova l'URL della pagina del produttore o di Vivino/Tannico
 * 2. Fetch server-side della pagina → estrae og:image o prima immagine prodotto
 * 3. Scarica l'immagine e restituisce base64
 */

/** Estrae l'URL di un'immagine rilevante dall'HTML di una pagina prodotto */
function extractImageFromHtml(html, baseUrl) {
  // 1. og:image (priorità alta, spesso è la foto del prodotto)
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (ogMatch) return resolveUrl(ogMatch[1], baseUrl);

  // 2. twitter:image
  const twMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (twMatch) return resolveUrl(twMatch[1], baseUrl);

  // 3. Prima immagine con parole chiave "bottle", "label", "wine", "vino", "bottiglia", "etichetta"
  const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  const keywords = /bottle|label|wine|vino|bottiglia|etichetta|prodotto|product/i;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    const context = match[0];
    if (keywords.test(src) || keywords.test(context)) {
      const url = resolveUrl(src, baseUrl);
      if (url && /\.(jpg|jpeg|png|webp)/i.test(url)) return url;
    }
  }

  return null;
}

function resolveUrl(src, baseUrl) {
  if (!src || src.startsWith("data:")) return null;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src.startsWith("http") ? src : null;
  }
}

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
    // Step 1: Claude + web_search trova la pagina del produttore o di Vivino
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
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Cerca su internet la pagina ufficiale del vino: "${wineDesc}".
Cerca prima il sito web del produttore "${producer || name}" e la pagina specifica di questo vino.
In alternativa cerca su Vivino, Tannico, Callmewine, o altre enoteche online.
Non è necessario che sia della stessa annata, basta che sia lo stesso vino dello stesso produttore.

Restituisci SOLO questo JSON (nient'altro):
{
  "pageUrl": "URL della pagina del vino sul sito del produttore o dell'enoteca",
  "imageUrl": "URL diretto immagine se visibile nei risultati (jpg/png/webp), altrimenti null"
}`,
        }],
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: `Errore API: ${err.slice(0, 200)}` }) };
    }

    const data = await response.json();
    const rawText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    console.log("Claude risponde:", rawText.slice(0, 400));

    // Estrai il JSON dalla risposta
    const jsonMatch = rawText.match(/\{[\s\S]*?"pageUrl"[\s\S]*?\}/);
    if (!jsonMatch) {
      return { statusCode: 404, body: JSON.stringify({ error: "Nessuna pagina trovata per questo vino" }) };
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return { statusCode: 404, body: JSON.stringify({ error: "Risposta non valida" }) }; }

    let imageUrl = parsed.imageUrl || null;
    const pageUrl = parsed.pageUrl || null;

    console.log("pageUrl:", pageUrl, "imageUrl:", imageUrl);

    // Step 2: se non abbiamo un'immagine diretta, fetch della pagina e estrai og:image
    if (!imageUrl && pageUrl) {
      try {
        const pageController = new AbortController();
        const pageTimeout = setTimeout(() => pageController.abort(), 8000);

        const pageResp = await fetch(pageUrl, {
          signal: pageController.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
            "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
          },
        });
        clearTimeout(pageTimeout);

        if (pageResp.ok) {
          const html = await pageResp.text();
          imageUrl = extractImageFromHtml(html, pageUrl);
          console.log("og:image estratto:", imageUrl);
        }
      } catch (pageErr) {
        console.log("Fetch pagina fallito:", pageErr.message);
      }
    }

    if (!imageUrl) {
      return { statusCode: 404, body: JSON.stringify({ error: "Nessuna immagine trovata per questo vino" }) };
    }

    // Step 3: scarica l'immagine e restituisci come base64
    const imgController = new AbortController();
    const imgTimeout = setTimeout(() => imgController.abort(), 8000);

    const imgResp = await fetch(imageUrl, {
      signal: imgController.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": pageUrl || new URL(imageUrl).origin,
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
    // Limite sicuro: restituisci solo se < 3MB
    if (arrayBuffer.byteLength > 3 * 1024 * 1024) {
      return { statusCode: 413, body: JSON.stringify({ error: "Immagine troppo grande" }) };
    }

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
