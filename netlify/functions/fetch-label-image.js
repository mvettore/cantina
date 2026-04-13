/**
 * Netlify Function: fetch-label-image
 * Strategia:
 * 1. Claude + web_search trova l'URL della PAGINA PRODOTTO diretta del vino
 * 2. Fetch della pagina → estrae immagine da JSON-LD schema o og:image filtrata
 * 3. Scarica l'immagine e restituisce base64
 */

/** Estrae URL immagine da JSON-LD Product schema */
function extractFromJsonLd(html) {
  const scriptTags = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const tag of scriptTags) {
    const json = tag.replace(/<script[^>]*>/, "").replace(/<\/script>/, "").trim();
    try {
      const data = JSON.parse(json);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        // Product schema con immagine
        if (item["@type"] === "Product" || item["@type"] === "Wine") {
          const img = item.image;
          if (typeof img === "string" && img.startsWith("http")) return img;
          if (Array.isArray(img) && img[0]) return typeof img[0] === "string" ? img[0] : img[0].url;
          if (img && img.url) return img.url;
        }
        // ImageObject diretta
        if (item["@type"] === "ImageObject" && item.url) return item.url;
      }
    } catch { /* JSON non valido, ignora */ }
  }
  return null;
}

/** Estrae og:image solo se sembra un'immagine prodotto (non promo/logo/screenshot) */
function extractOgImage(html, baseUrl) {
  const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (!ogMatch) return null;

  const url = resolveUrl(ogMatch[1], baseUrl);
  if (!url) return null;

  // Scarta immagini che sembrano loghi, promo, screenshot di app o placeholder generici
  const blocklist = /logo|banner|promo|social|default|placeholder|og-default|og_default|app[-_]store|google[-_]play|screenshot|hero|cover|background|favicon|icon/i;
  if (blocklist.test(url)) return null;

  // Deve sembrare un'immagine reale (estensione o CDN immagini)
  const looksLikeImage = /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url)
    || /\/(images?|img|photos?|media|prodotti|products?|catalog)\//i.test(url)
    || /cdn|assets|static/i.test(url);
  if (!looksLikeImage) return null;

  return url;
}

/** Prima <img> con keyword bottiglia/etichetta nell'src o nell'alt */
function extractProductImg(html, baseUrl) {
  const imgRegex = /<img[^>]+>/gi;
  const keywords = /bottle|label|wine|vino|bottiglia|etichetta|prodotto|product/i;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    const tag = match[0];
    const srcMatch = tag.match(/src=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const src = srcMatch[1];
    if (src.startsWith("data:") || src.includes("logo") || src.includes("icon")) continue;
    const altMatch = tag.match(/alt=["']([^"']*?)["']/i);
    const alt = altMatch ? altMatch[1] : "";
    if (keywords.test(src) || keywords.test(alt) || keywords.test(tag)) {
      const url = resolveUrl(src, baseUrl);
      if (url && /\.(jpg|jpeg|png|webp)/i.test(url)) return url;
    }
  }
  return null;
}

function resolveUrl(src, baseUrl) {
  if (!src || src.startsWith("data:")) return null;
  try { return new URL(src, baseUrl).href; } catch { return src.startsWith("http") ? src : null; }
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
    // Step 1: Claude + web_search trova la pagina prodotto diretta
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
          content: `Cerca la pagina PRODOTTO SPECIFICA del vino "${name}"${producer ? ` prodotto da "${producer}"` : ""}.

REGOLE IMPORTANTI:
- Cerca PRIMA il sito web ufficiale del produttore "${producer || name}" e la pagina dedicata a questo vino specifico.
- Solo se non esiste sito del produttore, cerca su Vivino (vivino.com/wines/...), Tannico, Callmewine o simili.
- Devi trovare la pagina SPECIFICA del vino (es. /vini/nome-vino), NON una pagina di ricerca o lista (es. /search?q=...).
- Non importa l'annata, basta che sia lo stesso vino dello stesso produttore.
- Se trovi più opzioni, preferisci quella del sito del produttore.

Restituisci SOLO questo JSON:
{
  "pageUrl": "URL pagina prodotto del vino (non pagine di ricerca o listing)",
  "source": "producer" oppure "retailer"
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
    console.log("stop_reason:", data.stop_reason, "content types:", (data.content||[]).map(b=>b.type).join(","));
    console.log("Claude risponde:", rawText.slice(0, 500));

    const jsonMatch = rawText.match(/\{[\s\S]*?"pageUrl"[\s\S]*?\}/);
    if (!jsonMatch) {
      return { statusCode: 404, body: JSON.stringify({ error: "Pagina prodotto non trovata" }) };
    }

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch { return { statusCode: 404, body: JSON.stringify({ error: "Risposta non valida" }) }; }

    const pageUrl = parsed.pageUrl || null;
    console.log("pageUrl:", pageUrl, "source:", parsed.source);

    if (!pageUrl) {
      return { statusCode: 404, body: JSON.stringify({ error: "Nessuna pagina trovata per questo vino" }) };
    }

    // Step 2: fetch della pagina prodotto ed estrai immagine
    let imageUrl = null;
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
        // Priorità: JSON-LD schema → og:image filtrata → prima img prodotto
        imageUrl = extractFromJsonLd(html)
          || extractOgImage(html, pageUrl)
          || extractProductImg(html, pageUrl);
        console.log("Immagine estratta:", imageUrl);
      }
    } catch (pageErr) {
      console.log("Fetch pagina fallito:", pageErr.message);
    }

    if (!imageUrl) {
      return { statusCode: 404, body: JSON.stringify({ error: "Nessuna immagine trovata nella pagina del vino" }) };
    }

    // Step 3: scarica l'immagine
    const imgController = new AbortController();
    const imgTimeout = setTimeout(() => imgController.abort(), 8000);

    const imgResp = await fetch(imageUrl, {
      signal: imgController.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": pageUrl,
      },
    });
    clearTimeout(imgTimeout);

    if (!imgResp.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Impossibile scaricare l'immagine" }) };
    }

    const contentType = imgResp.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return { statusCode: 502, body: JSON.stringify({ error: "L'URL trovato non è un'immagine" }) };
    }

    const arrayBuffer = await imgResp.arrayBuffer();
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
      body: JSON.stringify({ dataUrl, source: parsed.source || "unknown" }),
    };

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") return { statusCode: 504, body: JSON.stringify({ error: "Timeout nella ricerca" }) };
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
