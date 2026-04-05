/**
 * Netlify Function: scan-label
 *
 * Riceve l'immagine in base64 dal frontend,
 * chiama l'API Anthropic sul server (dove la chiave è al sicuro),
 * e restituisce il JSON con i dati del vino.
 *
 * La chiave API non viene mai esposta al browser.
 */

export default async (req) => {
  // Solo POST
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Leggi il body
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body non valido" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { base64, mediaType } = body;
  if (!base64 || !mediaType) {
    return new Response(JSON.stringify({ error: "Campi mancanti: base64, mediaType" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Chiave API dall'environment (impostata su Netlify, mai nel codice)
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "API key non configurata" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const prompt = `Sei un esperto enologo. Analizza questa etichetta di vino.
Usa la ricerca web per trovare informazioni aggiuntive sul vino se il testo dell'etichetta non è sufficiente.

Restituisci ESCLUSIVAMENTE un oggetto JSON valido (niente testo prima o dopo), con questi campi:
{
  "name": "nome commerciale del vino (es. Barolo Riserva, non il produttore)",
  "producer": "nome della cantina/produttore",
  "year": 2019,
  "type": "uno tra: Rosso, Bianco, Rosato, Spumante, Dolce, Passito",
  "region": "regione italiana (es. Piemonte, Toscana) o paese se estero",
  "grape": "vitigno o uvaggio principale",
  "notes": "2-3 frasi di descrizione organolettica o storia del vino",
  "price": null
}

Se un campo non è determinabile, usa null. Per il tipo, deducilo dal vitigno/denominazione se non esplicitato.`;

  try {
    const anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text();
      return new Response(JSON.stringify({ error: `Anthropic API error: ${errText}` }), {
        status: anthropicResp.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await anthropicResp.json();

    // Estrai l'ultimo blocco di testo (dopo eventuali tool call)
    const textBlocks = (data.content || []).filter(b => b.type === "text");
    const raw = textBlocks.map(b => b.text).join("").trim();
    const clean = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    // Verifica che sia JSON valido prima di rimandarlo
    JSON.parse(clean); // lancia eccezione se malformato

    return new Response(clean, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = {
  path: "/api/scan-label",
};
