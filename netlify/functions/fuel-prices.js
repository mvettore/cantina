/**
 * Proxy verso l'API Osservaprezzi Carburanti del MIMIT (ex MISE).
 * È la stessa API usata dal portale https://carburanti.mise.gov.it/ospzSearch/zona
 *
 * Formato richiesta (POST /ospzApi/search/zone):
 *   { points: [{lat,lng}, ...], radius?, fuelType: "F-M", priceOrder: "asc"|"desc" }
 * dove F = 0 tutti, 1 benzina, 2 gasolio, 3 metano, 4 GPL, 323 GNC, 324 GNL
 * e M = x tutti, 1 self, 0 servito.
 *
 * Il proxy serve per due motivi:
 *  - evitare problemi CORS dal browser
 *  - avere un punto unico dove gestire fallback e cache
 *
 * GET /.netlify/functions/fuel-prices?lat=44.89&lng=8.65&radius=10
 * Risposta: { success, results: [ { id, name, brand, address, location:{lat,lng}, fuels:[{name, price, isSelf, fuelId}] } ] }
 */

const API_BASE = "https://carburanti.mise.gov.it/ospzApi";

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    // Cache CDN 5 minuti: i prezzi vengono comunicati al massimo una volta al giorno,
    // ma teniamo la cache breve per non servire dati stantii dopo cambio parametri.
    "Cache-Control": "public, max-age=300",
  };

  try {
    const params = event.queryStringParameters || {};
    const lat = parseFloat(params.lat);
    const lng = parseFloat(params.lng);
    const radius = Math.min(Math.max(parseFloat(params.radius) || 10, 1), 35);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Parametri lat/lng mancanti o non validi" }) };
    }

    const commonHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "prezzi-carburanti-proxy/1.0",
    };

    const attempts = [];

    // Tentativo 1: punto + raggio, tutti i carburanti (il filtro si fa nel client)
    let outcome = await searchZone(commonHeaders, {
      points: [{ lat, lng }],
      radius,
      fuelType: "0-x",
      priceOrder: "asc",
    });
    attempts.push(outcome);

    // Tentativo 2 (fallback): poligono — quadrato centrato sulla posizione.
    // 1 grado di latitudine ≈ 111 km; per la longitudine correggiamo con cos(lat).
    if (!outcome.data) {
      const dLat = radius / 111;
      const dLng = radius / (111 * Math.cos((lat * Math.PI) / 180));
      outcome = await searchZone(commonHeaders, {
        points: [
          { lat: lat - dLat, lng: lng - dLng },
          { lat: lat - dLat, lng: lng + dLng },
          { lat: lat + dLat, lng: lng + dLng },
          { lat: lat + dLat, lng: lng - dLng },
        ],
        fuelType: "0-x",
        priceOrder: "asc",
      });
      attempts.push(outcome);
    }

    if (!outcome.data) {
      const detail = attempts.map((a, i) => `tentativo ${i + 1}: ${a.error}`).join(" | ");
      throw new Error(detail);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, center: { lat, lng }, radius, results: outcome.data.results }),
    };
  } catch (err) {
    console.error(`[fuel-prices] ${err.message}`);
    return {
      statusCode: 502,
      headers: { ...headers, "Cache-Control": "no-store" },
      body: JSON.stringify({ error: `Portale carburanti non raggiungibile — ${err.message}` }),
    };
  }
};

async function searchZone(headers, body) {
  try {
    const resp = await fetch(`${API_BASE}/search/zone`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      console.error(`[fuel-prices] search/zone HTTP ${resp.status}: ${text.substring(0, 300)}`);
      return { data: null, error: `HTTP ${resp.status} ${text.substring(0, 120)}` };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { data: null, error: `risposta non JSON: ${text.substring(0, 120)}` };
    }
    if (!data || !Array.isArray(data.results)) {
      return { data: null, error: `JSON senza results: ${text.substring(0, 120)}` };
    }
    return { data, error: null };
  } catch (err) {
    console.error(`[fuel-prices] search/zone errore rete: ${err.message}`);
    return { data: null, error: `rete: ${err.message}` };
  }
}
