/**
 * Netlify Function: upload-photo
 * Proxy server-side per caricare foto dei vini su Supabase Storage.
 *
 * Il client manda base64 → la function decodifica in Buffer → upload al
 * bucket `wine-photos` (creato al primo uso se non esiste) → ritorna l'URL
 * pubblico da salvare in wine.photos[].
 *
 * Usa la service key di Supabase che resta lato server (non esposta al client).
 *
 * POST /.netlify/functions/upload-photo
 * Body: { wineId, index, base64, mediaType }
 * Returns: { url, path }
 */

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const BUCKET        = "wine-photos";

// Assicura che il bucket "wine-photos" esista (public).
// Nota: Supabase su "bucket check" GET ritorna HTTP 400 con body
// {statusCode:"404",error:"Bucket not found"} quando non esiste, quindi il
// check via GET non e affidabile. Usiamo direttamente POST /bucket che e
// idempotente: se il bucket esiste gia ritorna un errore "already exists"
// che trattiamo come successo.
async function ensureBucket() {
  try {
    const create = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: BUCKET,
        name: BUCKET,
        public: true,
        file_size_limit: 2 * 1024 * 1024, // 2MB per file
        allowed_mime_types: ["image/jpeg", "image/png", "image/webp", "image/heic"],
      }),
    });

    if (create.ok) {
      console.log(`[upload-photo] bucket "${BUCKET}" created (public)`);
      return true;
    }

    const errText = await create.text().catch(() => "");
    // "Bucket already exists" / "The resource already exists" → OK
    if (
      /already\s*exists/i.test(errText) ||
      /duplicate/i.test(errText) ||
      create.status === 409
    ) {
      return true; // bucket gia presente, procediamo con upload
    }

    console.error(`[upload-photo] bucket create HTTP ${create.status}: ${errText.substring(0, 200)}`);
    return false;
  } catch (err) {
    console.error(`[upload-photo] ensureBucket fetch error: ${err.message}`);
    return false;
  }
}

const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Supabase non configurato" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Body non valido" }) };
  }

  const { wineId, index, base64, mediaType } = body;
  if (wineId == null || index == null || !base64) {
    return { statusCode: 400, body: JSON.stringify({ error: "Campi mancanti: wineId, index, base64" }) };
  }

  // Assicura che il bucket esista prima di fare upload
  const bucketOk = await ensureBucket();
  if (!bucketOk) {
    return { statusCode: 500, body: JSON.stringify({ error: "Impossibile creare/verificare il bucket wine-photos" }) };
  }

  // Il client può mandare o solo il base64 puro, o il data URL completo.
  // Togliamo il prefisso "data:image/jpeg;base64," se presente.
  const pure = String(base64).replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(pure, "base64");
  const mime = mediaType || "image/jpeg";
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";

  // Path con timestamp: evita cache stale del browser se re-upload la stessa posizione,
  // e garantisce unicità anche se lo stesso wineId+index viene riusato.
  const timestamp = Date.now();
  const path = `${wineId}/${timestamp}-${index}.${ext}`;

  console.log(`[upload-photo] uploading ${path} (${buffer.length} bytes, ${mime})`);

  try {
    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": mime,
        "x-upsert": "true",
      },
      body: buffer,
    });

    if (!uploadResp.ok) {
      const errText = await uploadResp.text().catch(() => "unknown");
      console.error(`[upload-photo] Supabase Storage HTTP ${uploadResp.status}: ${errText.substring(0, 300)}`);
      return {
        statusCode: uploadResp.status,
        body: JSON.stringify({ error: `Upload fallito: ${errText.substring(0, 200)}` }),
      };
    }

    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    console.log(`[upload-photo] OK ${path} → ${url}`);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, path }),
    };
  } catch (err) {
    console.error(`[upload-photo] fetch error: ${err.message}`);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

module.exports = { handler };
