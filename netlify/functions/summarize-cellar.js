/**
 * Netlify Function: summarize-cellar
 * Riceve la composizione della cantina e lo storico degustazioni recente,
 * restituisce un paragrafo di analisi: punti di forza, lacune, vini urgenti.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "API key non configurata" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const wines = Array.isArray(body.wines) ? body.wines : [];
  const log   = Array.isArray(body.log)   ? body.log   : [];

  if (wines.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "Cantina vuota" }) };
  }

  // Aggrega: totale bt, per tipo, per vitigno, per regione, urgenti, valore
  const totalBt = wines.reduce((s,w) => s + (w.quantity||0), 0);
  const totalValue = wines.reduce((s,w) => s + (w.quantity||0) * (parseFloat(w.price)||0), 0);
  const byType = {}, byGrape = {}, byRegion = {};
  let urgentCount = 0;
  const urgentList = [];
  wines.forEach(w => {
    const q = w.quantity || 0;
    if (w.type)   byType[w.type]     = (byType[w.type]   || 0) + q;
    if (w.grape)  byGrape[w.grape]   = (byGrape[w.grape] || 0) + q;
    if (w.region) byRegion[w.region] = (byRegion[w.region] || 0) + q;
    if ((w.agingStatus === "Maturo" || w.agingStatus === "Declino") && q > 0) {
      urgentCount += q;
      if (urgentList.length < 8) urgentList.push(`${w.name} ${w.year||""}`.trim());
    }
  });
  const topN = (obj, n) => Object.entries(obj).sort(([,a],[,b])=>b-a).slice(0,n);

  const composition = {
    totaleBottiglie: totalBt,
    valoreTotale: totalValue > 0 ? `€${totalValue.toFixed(0)}` : null,
    perTipologia: topN(byType, 6),
    perVitigno:   topN(byGrape, 8),
    perRegione:   topN(byRegion, 8),
    viniUrgenti: urgentCount,
    esempiUrgenti: urgentList,
    degustazioniRecenti: log.length,
    vitigniRecenti: [...new Set(log.map(e => e.wineGrape).filter(Boolean))].slice(0, 10),
    preferiti: log.filter(e => e.favorite).slice(0, 5).map(e => `${e.wineName} (${e.wineType||""})`),
  };

  const prompt = `Sei un sommelier esperto che sta analizzando una cantina personale.

Questi sono i dati aggregati:
${JSON.stringify(composition, null, 2)}

Scrivi un'analisi della cantina in italiano, in 3-4 paragrafi brevi (max 200 parole totali), con questa struttura:

1. Identità della cantina: com'è caratterizzata, quali vitigni/regioni dominano, che tipo di collezionista emerge dai numeri.
2. Punti di forza: cosa c'è di notevole o coerente.
3. Lacune o squilibri: cosa manca per una cantina ben bilanciata (es. poco bianco, nessun passito, troppa concentrazione su una sola regione). Sii specifico.
4. Priorità del momento: se ci sono vini urgenti da bere o decisioni da prendere a breve.

Sii concreto, evita generalismi da catalogo. Parla direttamente al proprietario ("hai…", "la tua cantina…"). Non ripetere i numeri che già vede nei grafici.

Rispondi ESCLUSIVAMENTE con un oggetto JSON valido:
{
  "summary": "testo multi-paragrafo separato da \\n\\n",
  "highlights": ["2-3 frasi chiave molto brevi, tipo bullet", "…"]
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
        max_tokens: 1000,
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
