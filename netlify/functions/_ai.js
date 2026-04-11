/**
 * Shared AI helper: usa Gemini (free tier) se GEMINI_API_KEY è settata,
 * altrimenti ricade su Anthropic Claude come fallback.
 *
 * Il file ha il prefisso underscore: Netlify lo bundla come dipendenza
 * delle altre function ma NON lo espone come endpoint.
 */

const GEMINI_MODEL_TEXT   = "gemini-2.0-flash";
const GEMINI_MODEL_VISION = "gemini-2.0-flash"; // stesso modello, supporta sia testo che immagini
const CLAUDE_MODEL_TEXT   = "claude-sonnet-4-20250514";
const CLAUDE_MODEL_VISION = "claude-haiku-4-5-20251001";

/**
 * Chiama l'AI provider attivo con un prompt + immagini opzionali.
 * @param {Object}   opts
 * @param {string}   opts.prompt       - testo del prompt
 * @param {number}   opts.maxTokens    - max token in output (default 1000)
 * @param {Array}    opts.images       - array di { base64, mediaType } per input multimodale
 * @param {boolean}  opts.jsonMode     - richiedi JSON puro in output (default true)
 * @param {number}   opts.temperature  - temperature (default 0.5)
 * @param {AbortSignal} opts.signal    - per timeout
 * @returns {Promise<string>} testo (già in trim) restituito dal modello
 */
async function callAI({
  prompt,
  maxTokens = 1000,
  images = [],
  jsonMode = true,
  temperature = 0.5,
  signal,
}) {
  // ── Provider 1: Gemini (preferito, free tier) ──
  if (process.env.GEMINI_API_KEY) {
    // Ordine parts: immagini prima, testo dopo (best practice per vision models)
    const parts = [];
    for (const img of images) {
      parts.push({
        inline_data: {
          mime_type: img.mediaType || "image/jpeg",
          data: img.base64,
        },
      });
    }
    parts.push({ text: prompt });

    const model = images.length > 0 ? GEMINI_MODEL_VISION : GEMINI_MODEL_TEXT;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const resp = await fetch(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: "application/json" } : {}),
        },
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      const err = new Error(`Gemini ${resp.status}: ${errText}`);
      err.status = resp.status;
      err.provider = "gemini";
      throw err;
    }

    const data = await resp.json();
    // Gemini può bloccare per safety: restituisce candidates vuoto o finishReason BLOCKED
    const cand = data.candidates?.[0];
    if (!cand) {
      throw new Error(`Gemini: nessun candidato in risposta (${JSON.stringify(data.promptFeedback || {})})`);
    }
    const text = (cand.content?.parts || [])
      .map(p => p.text || "")
      .join("")
      .trim();
    return text;
  }

  // ── Provider 2: Anthropic Claude (fallback) ──
  if (process.env.ANTHROPIC_API_KEY) {
    const content = [];
    for (const img of images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType || "image/jpeg",
          data: img.base64,
        },
      });
    }
    content.push({ type: "text", text: prompt });

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: images.length > 0 ? CLAUDE_MODEL_VISION : CLAUDE_MODEL_TEXT,
        max_tokens: maxTokens,
        messages: [{ role: "user", content }],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      const err = new Error(`Anthropic ${resp.status}: ${errText}`);
      err.status = resp.status;
      err.provider = "anthropic";
      throw err;
    }

    const data = await resp.json();
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("")
      .trim();
    return text;
  }

  throw new Error("Nessuna API key configurata: imposta GEMINI_API_KEY (preferito) o ANTHROPIC_API_KEY");
}

/**
 * Parse robusto di JSON da risposta AI. Rimuove fence markdown se presenti
 * (Gemini con responseMimeType=application/json di solito non li aggiunge,
 * ma Claude sì, quindi meglio essere conservativi).
 */
function parseJSONResponse(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Risposta AI vuota o non valida");
  }
  const clean = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  return JSON.parse(clean);
}

/**
 * Restituisce il nome del provider attivo (per logging/debug).
 */
function activeProvider() {
  if (process.env.GEMINI_API_KEY)    return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "none";
}

module.exports = { callAI, parseJSONResponse, activeProvider };
