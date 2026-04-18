/**
 * Netlify Function: enrich-producer
 * Usa Claude con lo strumento web_search per trovare la scheda ufficiale
 * del vino sul sito del produttore e sintetizzarne le informazioni.
 */

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY non configurata" }),
    };
  }

  let wine;
  try {
    wine = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  if (!wine.producer && !wine.name) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Servono almeno il produttore o il nome del vino" }),
    };
  }

  const prompt = `Devi trovare la SCHEDA UFFICIALE di questo vino sul sito web del PRODUTTORE (cantina) e sintetizzarne i contenuti.

Dati del vino:
- Nome: ${wine.name || "—"}
- Produttore/Cantina: ${wine.producer || "—"}
- Annata: ${wine.year || "—"}
- Denominazione: ${wine.denomination || "—"}
- Regione: ${wine.region || "—"}
- Tipologia: ${wine.type || "—"}

ISTRUZIONI:
1) Usa web_search per trovare il sito ufficiale del produttore "${wine.producer || ""}".
2) Cerca sul sito la pagina dedicata a "${wine.name || ""}". Ignora shop online, e-commerce di terzi (Tannico, Vino.com, ecc.): voglio SOLO la pagina sul sito della cantina stessa.
3) Se la pagina contiene dati (descrizione, scheda tecnica, note degustazione, abbinamenti) ESTRAI il testo rilevante.
4) Se il sito del produttore non è raggiungibile o non ha una pagina sul vino, indica chiaramente \`"found": false\`.

RISPONDI ESCLUSIVAMENTE con un oggetto JSON valido (nessun testo fuori dal JSON), senza fence markdown:
{
  "found": true | false,
  "producerUrl": "URL del sito ufficiale del produttore (homepage)",
  "wineUrl": "URL della pagina specifica del vino sul sito del produttore, se trovata",
  "description": "descrizione del vino dalla scheda ufficiale, 2-4 frasi (parafrasa, non copia verbatim)",
  "technicalSheet": "scheda tecnica: vitigni, vinificazione, affinamento, gradazione alcolica, temperatura di servizio (elenco separato da virgole o punti, max 6-8 voci)",
  "tastingNotes": "note di degustazione ufficiali: colore, naso, palato (2-4 frasi)",
  "foodPairing": "abbinamenti consigliati dal produttore",
  "awards": "eventuali premi/riconoscimenti citati dal produttore (se presenti, altrimenti stringa vuota)",
  "sourceNote": "una frase su dove hai trovato le info (es. 'Dalla pagina ufficiale del produttore')"
}

Se \`found\` è false, tutti gli altri campi possono essere stringhe vuote eccetto \`sourceNote\` in cui spieghi perché non hai trovato.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 24000);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      console.error(`[enrich-producer] HTTP ${resp.status}: ${errText.substring(0, 400)}`);
      return {
        statusCode: 502,
        body: JSON.stringify({ error: `Anthropic ${resp.status}` }),
      };
    }

    const data = await resp.json();

    const textBlocks = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!textBlocks) {
      return {
        statusCode: 502,
        body: JSON.stringify({ error: "Risposta vuota dal modello" }),
      };
    }

    const cleaned = textBlocks
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          console.error(`[enrich-producer] parse JSON fallito: ${cleaned.substring(0, 200)}`);
          return {
            statusCode: 502,
            body: JSON.stringify({ error: "Risposta modello non in JSON valido" }),
          };
        }
      } else {
        return {
          statusCode: 502,
          body: JSON.stringify({ error: "Risposta modello non in JSON valido" }),
        };
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[enrich-producer] error: ${err.message}`);
    if (err.name === "AbortError") {
      return {
        statusCode: 504,
        body: JSON.stringify({ error: "Timeout ricerca sul sito produttore" }),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Errore sconosciuto" }),
    };
  }
};

exports.handler = handler;
