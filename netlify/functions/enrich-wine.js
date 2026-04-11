/**
 * Netlify Function: enrich-wine
 * Riceve i dati base di un vino e restituisce informazioni approfondite
 * su vitigno, territorio, sentori e abbinamenti.
 * Provider AI: Gemini (default, free tier) con fallback su Anthropic.
 */

const { callAI, parseJSONResponse, activeProvider } = require("./_ai");

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (activeProvider() === "none") {
    return { statusCode: 500, body: JSON.stringify({ error: "Nessuna API key configurata (GEMINI_API_KEY o ANTHROPIC_API_KEY)" }) };
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

IMPORTANTE: tutte le informazioni devono essere specifiche per la regione/denominazione indicata sopra, NON per la zona più famosa del vitigno. Ad esempio, se il vitigno è Nebbiolo ma la regione è Valli Ossolane, parla delle Valli Ossolane — non delle Langhe.

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido (nessun testo fuori dal JSON):
{
  "grapeProfile": "2-3 frasi sul carattere del vitigno: origini, caratteristiche genetiche, come si esprime specificamente in questa regione/denominazione",
  "tastingNotes": "3-4 frasi sui sentori tipici di questo vino in questa zona: profumi (primari, secondari, terziari se invecchiato), palato (struttura, tannini, acidità, corpo, finale)",
  "territory": "2-3 frasi sul territorio specifico indicato: suolo, microclima, altitudine, caratteristiche che lo distinguono da altre zone dello stesso vitigno",
  "aging": "1-2 frasi sul potenziale di invecchiamento e se aprire ora o aspettare",
  "peakFrom": <numero intero: anni dalla vendemmia in cui inizia il momento ottimale di beva>,
  "peakTo": <numero intero: anni dalla vendemmia in cui finisce il momento ottimale di beva>,
  "foodPairing": "3-4 abbinamenti gastronomici ideali, separati da virgola",
  "curiosity": "1 curiosità storica o anecdoto interessante su questo vino, produttore o sulla storia vinicola di questa specifica zona"
}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const raw = await callAI({
      prompt,
      maxTokens: 1200,
      temperature: 0.5,
      jsonMode: true,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const parsed = parseJSONResponse(raw);
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
    return { statusCode: err.status || 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
