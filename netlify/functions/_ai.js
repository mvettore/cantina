/**
 * Shared AI helper: Anthropic Claude.
 *
 * Gemini è stato rimosso: il modello che usavamo (gemini-1.5-flash) è stato
 * ritirato da Google e non aveva un sostituto stabile, quindi ogni richiesta
 * sprecava un round-trip verso un 404 prima di ricadere su Claude.
 *
 * Il file ha il prefisso underscore: Netlify lo bundla come dipendenza
 * delle altre function ma NON lo espone come endpoint.
 */

// Haiku per la vision (lettura etichette): veloce ed economico, sufficiente per l'OCR.
// Sonnet per il testo (analisi, abbinamenti, stime di valore).
const CLAUDE_MODEL_TEXT   = process.env.CLAUDE_MODEL_TEXT   || "claude-sonnet-5";
const CLAUDE_MODEL_VISION = process.env.CLAUDE_MODEL_VISION || "claude-haiku-4-5";

/**
 * Chiama Claude con un prompt + immagini opzionali.
 * @param {object} opts
 * @param {string} opts.prompt      testo del prompt
 * @param {number} [opts.maxTokens] default 1000
 * @param {Array}  [opts.images]    [{ base64, mediaType }] — attiva il modello vision
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} testo (trim) restituito dal modello
 */
async function callAI(opts) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata");
  }
  return await callClaude(opts);
}

async function callClaude({
  prompt,
  maxTokens = 1000,
  images = [],
  signal,
}) {
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

  const model = images.length > 0 ? CLAUDE_MODEL_VISION : CLAUDE_MODEL_TEXT;
  console.log(`[anthropic] model=${model} images=${images.length}`);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "unknown");
    console.error(`[anthropic] HTTP ${resp.status}: ${errText.substring(0, 500)}`);
    const err = new Error(`Anthropic ${resp.status}: ${errText.substring(0, 300)}`);
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

  if (!text) {
    console.error(`[anthropic] risposta vuota`);
    throw new Error("Anthropic: risposta vuota");
  }

  console.log(`[anthropic] OK ${text.length} chars`);
  return text;
}

/**
 * Parse robusto di JSON da risposta AI. Rimuove fence markdown se presenti.
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
  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error(`[_ai] JSON parse failed. Raw (first 300 chars): ${clean.substring(0, 300)}`);
    throw new Error(`JSON parse: ${err.message}. Primi 100 char: ${clean.substring(0, 100)}`);
  }
}

/**
 * Provider attivo (per logging).
 */
function activeProvider() {
  return process.env.ANTHROPIC_API_KEY ? "anthropic" : "none";
}

module.exports = { callAI, parseJSONResponse, activeProvider };
