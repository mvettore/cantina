/**
 * Netlify Function: enrich-wine
 * Riceve i dati base di un vino e restituisce informazioni approfondite
 * su vitigno, territorio, sentori e abbinamenti.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key non configurata" }) };
  }

  let wine;
  try {
    wine = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const prompt = `Sei un sommelier esperto e storico del vino italiano.
Fornisci informazioni dettagliate su questo vino basandoti ESCLUSIVAMENTE su conoscenze reali e verificate. NON inventare dati, NON allucinare caratteristiche, produttori o denominazioni. Se non hai informazioni certe su un campo, descrivilo in modo generico basandoti sul vitigno e sulla regione senza inventare specifiche del produttore.

Nome: ${wine.name || "—"}
Produttore: ${wine.producer || "—"}
Annata: ${wine.year || "—"}
Tipologia: ${wine.type || "—"}
Regione: ${wine.region || "—"}
Vitigno: ${wine.grape || "—"}

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido (nessun testo fuori dal JSON):
{
  "grapeProfile": "2-3 frasi sul carattere del vitigno: origini, caratteristiche genetiche, zone di elezione, stile generale che dona ai vini",
  "tastingNotes": "3-4 frasi sui sentori tipici: descrivi profumi (primari, secondari, terziari se invecchiato), palato (struttura, tannini, acidità, corpo, finale)",
  "territory": "2-3 frasi sul territorio e denominazione: suolo, microclima, perché quella zona è vocata per questo vitigno",
  "aging": "1-2 frasi sul potenziale di invecchiamento e se aprire ora o aspettare",
  "foodPairing": "3-4 abbinamenti gastronomici ideali, separati da virgola",
  "curiosity": "1 curiosità storica o aneddoto interessante su questo vino o produttore"
}`;

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
        model: "claude-sonnet-4-20250514",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, body: JSON.stringify({ error: err }) };
    }

    const data = await response.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(clean);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      return { statusCode: 504, body: JSON.stringify({ error: "Timeout" }) };
    }
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
