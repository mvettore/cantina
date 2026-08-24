/**
 * Shared AI helper: usa Gemini (free tier) se GEMINI_API_KEY è settata,
 * altrimenti ricade su Anthropic Claude come fallback.
 *
 * Il file ha il prefisso underscore: Netlify lo bundla come dipendenza
 * delle altre function ma NON lo espone come endpoint.
 */

// ATTENZIONE: gemini-1.5-flash è stato RITIRATO da Google (le richieste tornano 404).
// Non esiste più un default sicuro: il modello va indicato via env GEMINI_MODEL
// (es. "gemini-3.6-flash"). Senza GEMINI_MODEL, Gemini viene saltato del tutto
// e si usa direttamente Claude, invece di sprecare un round-trip verso un 404.
const GEMINI_MODEL_TEXT   = process.env.GEMINI_MODEL || null;
const GEMINI_MODEL_VISION = process.env.GEMINI_MODEL || null;
const CLAUDE_MODEL_TEXT   = "claude-sonnet-4-20250514";
const CLAUDE_MODEL_VISION = "claude-haiku-4-5-20251001";

// Flag: se true, al fallimento di Gemini tenta automaticamente Claude.
// Default ON: vogliamo che l'app funzioni comunque per l'utente.
const FALLBACK_TO_CLAUDE_ON_GEMINI_ERROR = process.env.DISABLE_CLAUDE_FALLBACK !== "true";

/**
 * Chiama l'AI provider attivo con un prompt + immagini opzionali.
 * @returns {Promise<string>} testo (trim) restituito dal modello
 */
async function callAI(opts) {
  // Gemini è utilizzabile solo con chiave E modello configurato: il vecchio
  // default (gemini-1.5-flash) è ritirato da Google e tornerebbe sempre 404.
  const geminiOk = !!process.env.GEMINI_API_KEY
    && !!(opts.images?.length ? GEMINI_MODEL_VISION : GEMINI_MODEL_TEXT);
  const claudeOk = !!process.env.ANTHROPIC_API_KEY;

  if (!geminiOk && !claudeOk) {
    throw new Error(process.env.GEMINI_API_KEY
      ? "GEMINI_MODEL non configurato (gemini-1.5-flash è ritirato) e ANTHROPIC_API_KEY assente"
      : "Nessuna API key configurata: imposta GEMINI_API_KEY + GEMINI_MODEL, oppure ANTHROPIC_API_KEY");
  }

  // opts.preferClaude è una preferenza (usata dalla vision), non un'esclusione:
  // se Claude non è disponibile si ricade comunque su Gemini.
  const order = opts.preferClaude && claudeOk
    ? [["anthropic", callClaude, claudeOk], ["gemini", callGemini, geminiOk]]
    : [["gemini", callGemini, geminiOk], ["anthropic", callClaude, claudeOk]];

  let lastErr;
  for (const [name, fn, usable] of order) {
    if (!usable) continue;
    if (lastErr && !FALLBACK_TO_CLAUDE_ON_GEMINI_ERROR) break;
    try {
      return await fn(opts);
    } catch (err) {
      console.error(`[_ai] ${name} ha fallito: ${err.message}`);
      lastErr = err;
      // Un abort è il nostro deadline: inutile provare l'altro provider.
      if (err.name === "AbortError") throw err;
    }
  }
  throw lastErr;
}

async function callGemini({
  prompt,
  maxTokens = 1000,
  images = [],
  jsonMode = true,
  temperature = 0.5,
  signal,
}) {
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

  console.log(`[gemini] model=${model} images=${images.length} jsonMode=${jsonMode} maxTokens=${maxTokens}`);

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
      // Safety: disabilitiamo i blocchi conservativi che potrebbero bloccare
      // foto di etichette di vino. BLOCK_NONE è il valore più permissivo.
      safetySettings: [
        { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "unknown");
    console.error(`[gemini] HTTP ${resp.status}: ${errText.substring(0, 500)}`);
    const err = new Error(`Gemini ${resp.status}: ${errText.substring(0, 300)}`);
    err.status = resp.status;
    err.provider = "gemini";
    throw err;
  }

  const data = await resp.json();
  const cand = data.candidates?.[0];

  if (!cand) {
    const feedback = JSON.stringify(data.promptFeedback || {}).substring(0, 300);
    console.error(`[gemini] nessun candidato. promptFeedback=${feedback}`);
    throw new Error(`Gemini: nessun candidato (${feedback})`);
  }

  // finishReason può essere: STOP, MAX_TOKENS, SAFETY, RECITATION, OTHER
  if (cand.finishReason && cand.finishReason !== "STOP" && cand.finishReason !== "MAX_TOKENS") {
    console.error(`[gemini] finishReason=${cand.finishReason}`);
    throw new Error(`Gemini bloccato: ${cand.finishReason}`);
  }

  const text = (cand.content?.parts || [])
    .map(p => p.text || "")
    .join("")
    .trim();

  if (!text) {
    console.error(`[gemini] risposta vuota. candidate=${JSON.stringify(cand).substring(0, 300)}`);
    throw new Error("Gemini: risposta vuota");
  }

  console.log(`[gemini] OK ${text.length} chars`);
  return text;
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
  // Gemini conta come disponibile solo con un modello configurato (vedi GEMINI_MODEL_TEXT)
  if (process.env.GEMINI_API_KEY && GEMINI_MODEL_TEXT) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "none";
}

module.exports = { callAI, parseJSONResponse, activeProvider };
