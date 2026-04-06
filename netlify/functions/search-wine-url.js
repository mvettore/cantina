/**
 * Netlify Function: search-wine-url
 * Cerca online una scheda autorevole per un vino specifico
 * e restituisce l'URL trovato. Viene chiamato in background
 * dopo l'arricchimento principale.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key mancante" }) };
  }

  let wine;
  try {
    wine = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  console.log(`[search-wine-url] Cerco scheda per: ${wine.name} - ${wine.producer} ${wine.year}`);

  const prompt = `Cerca online la scheda di questo vino:
Nome: ${wine.name || "—"}
Produttore: ${wine.producer || "—"}
Annata: ${wine.year || "—"}

Trova la pagina più autorevole disponibile (nell'ordine: sito ufficiale del produttore, vivino.com, wine-searcher.com, gamberorosso.it, winemag.it, decanter.com).
IMPORTANTE: inserisci SOLO un URL che hai trovato realmente tramite la ricerca web e che hai verificato esistere. NON inventare URL, NON costruire URL ipotetici. Se non trovi nessuna scheda reale, restituisci null.
Rispondi ESCLUSIVAMENTE con questo JSON (nessun altro testo):
{"url": "url reale trovato tramite ricerca, oppure null se non trovato"}`;

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
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text();
      console.error(`[search-wine-url] API error ${response.status}:`, err);
      return { statusCode: response.status, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();
    console.log(`[search-wine-url] stop_reason: ${data.stop_reason}, content blocks: ${data.content?.length}`);

    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    console.log(`[search-wine-url] testo grezzo: ${raw.substring(0, 200)}`);

    // Prova prima il parsing JSON standard
    let wineCardUrl = null;
    try {
      const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(clean);
      wineCardUrl = parsed.url || null;
    } catch {
      // Fallback: estrai l'URL direttamente dalla stringa
      const urlMatch = raw.match(/"url"\s*:\s*"(https?:\/\/[^"]+)"/);
      if (urlMatch) wineCardUrl = urlMatch[1];
    }

    console.log(`[search-wine-url] URL trovato: ${wineCardUrl}`);

    // Verifica che l'URL esista realmente (non sia un 404)
    if (wineCardUrl) {
      try {
        const check = await fetch(wineCardUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
        if (!check.ok) {
          console.warn(`[search-wine-url] URL non raggiungibile (${check.status}), scartato: ${wineCardUrl}`);
          wineCardUrl = null;
        } else {
          console.log(`[search-wine-url] URL verificato OK (${check.status})`);
        }
      } catch {
        console.warn(`[search-wine-url] Verifica URL fallita, scartato: ${wineCardUrl}`);
        wineCardUrl = null;
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wineCardUrl }),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      console.error("[search-wine-url] Timeout");
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout" }) };
    }
    console.error("[search-wine-url] Errore:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
