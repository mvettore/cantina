/**
 * Proxy verso l'API Osservaprezzi Carburanti del MIMIT (ex MISE).
 * È la stessa API usata dal portale https://carburanti.mise.gov.it/ospzSearch/zona
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
      // Il backend ministeriale a volte rifiuta richieste senza UA "da browser"
      "User-Agent": "Mozilla/5.0 (compatible; PrezziCarburanti/1.0)",
    };

    // Tentativo 1: ricerca per punto + raggio (formato usato dall'app ufficiale)
    let data = await searchZone(commonHeaders, {
      points: [{ lat, lng }],
      radius,
      priceOrder: "asc",
    });

    // Tentativo 2 (fallback): ricerca per poligono — quadrato centrato sulla posizione.
    // 1 grado di latitudine ≈ 111 km; per la longitudine correggiamo con cos(lat).
    if (!data || !Array.isArray(data.results)) {
      const dLat = radius / 111;
      const dLng = radius / (111 * Math.cos((lat * Math.PI) / 180));
      data = await searchZone(commonHeaders, {
        points: [
          { lat: lat - dLat, lng: lng - dLng },
          { lat: lat - dLat, lng: lng + dLng },
          { lat: lat + dLat, lng: lng + dLng },
          { lat: lat + dLat, lng: lng - dLng },
        ],
        priceOrder: "asc",
      });
    }

    if (!data || !Array.isArray(data.results)) {
      throw new Error("Risposta inattesa dal portale MIMIT");
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, center: { lat, lng }, radius, results: data.results }),
    };
  } catch (err) {
    console.error(`[fuel-prices] ${err.message}`);
    return {
      statusCode: 502,
      headers: { ...headers, "Cache-Control": "no-store" },
      body: JSON.stringify({ error: `Portale carburanti non raggiungibile: ${err.message}` }),
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
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(`[fuel-prices] search/zone HTTP ${resp.status}: ${text.substring(0, 300)}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`[fuel-prices] search/zone errore rete: ${err.message}`);
    return null;
  }
}
