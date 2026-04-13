/**
 * Script di recupero una-tantum per il vino "Carlo Magno" perso da production.
 * Uso: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/recover-carlo-magno.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Mancano le variabili d'ambiente SUPABASE_URL e SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const apiBase = `${SUPABASE_URL}/rest/v1/cantina_data`;
const headers = {
  "Content-Type": "application/json",
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
};

const carloMagno = {
  "id": 102,
  "name": "Carlo Magno",
  "type": "Rosso",
  "year": 2019,
  "grape": "Barbera",
  "notes": "Al naso presenta intensi profumi di frutta rossa matura, ciliegia e prugna, arricchiti da note speziate di pepe nero e chiodi di garofano. In bocca mostra un carattere deciso con la tipica acidità vivace della Barbera ben bilanciata da una struttura tannica elegante. Il corpo è pieno e avvolgente, con un finale persistente che richiama le sensazioni olfattive con un tocco di liquirizia. L'equilibrio tra freschezza e concentrazione rende questo vino di grande bevibilità.",
  "photos": [],
  "price": "",
  "rating": 3,
  "region": "Piemonte",
  "producer": "Cascina Perfumo",
  "quantity": 1,
  "positions": [],
  "rackSlots": [{ "rackId": 1, "positions": ["A4"] }],
  "enrichment": {
    "aging": "Il 2019 è attualmente nel suo periodo di massima espressione, mostrando un perfetto equilibrio tra freschezza giovanile e complessità evolutiva. Può essere gustato ora per apprezzarne la vivacità fruttata, ma ha un potenziale di invecchiamento di 8-10 anni durante i quali svilupperà note terziarie più complesse.",
    "curiosity": "Il nome 'Carlo Magno' potrebbe essere un omaggio all'imperatore che secondo alcune leggende storiche attraversò queste terre monferrine durante le sue campagne, lasciando un'impronta culturale che ancora oggi caratterizza la tradizione vitivinicola della zona.",
    "territory": "I vigneti di Cascina Perfumo si trovano nelle colline del Monferrato, territorio ideale per la Barbera grazie ai suoli calcareo-argillosi ricchi di minerali. Il microclima della zona, caratterizzato da escursioni termiche significative tra giorno e notte, favorisce lo sviluppo degli aromi e mantiene la caratteristica acidità del vitigno. Questa zona vocata permette alla Barbera di esprimere al meglio la sua eleganza e complessità strutturale.",
    "foodPairing": "Brasato al Barolo, tajarin al tartufo, formaggi stagionati piemontesi, agnolotti del plin",
    "grapeProfile": "La Barbera è un vitigno autoctono piemontese di grande personalità, caratterizzato da una spiccata acidità naturale e da una struttura elegante. Originaria delle colline del Monferrato e delle Langhe, questa varietà si distingue per la sua capacità di esprimere al meglio il terroir di origine, donando vini di grande bevibilità e longevità. Il suo carattere vivace e la naturale propensione all'invecchiamento la rendono una delle eccellenze enologiche del Piemonte.",
    "tastingNotes": "Al naso si presenta con intense note di frutta rossa matura, ciliegia e prugna, arricchite da sfumature speziate di pepe nero e note balsamiche. In bocca rivela una struttura equilibrata con tannini setosi e ben integrati, sostenuta da una caratteristica acidità che dona freschezza e slancio. Il corpo è pieno e avvolgente, con un finale persistente che richiama i sentori fruttati e speziati percepiti all'olfatto.",
    "enrichedAt": new Date().toISOString(),
  },
};

async function main() {
  // 1. Leggi i vini attuali da production
  const r = await fetch(`${apiBase}?select=key,value&key=eq.wines`, { headers });
  const rows = await r.json();
  if (!Array.isArray(rows)) { console.error("Errore lettura Supabase:", rows); process.exit(1); }

  const row = rows.find(r => r.key === "wines");
  const currentWines = row?.value ?? [];
  console.log(`Vini in production: ${currentWines.length}`);

  // 2. Controlla se Carlo Magno è già presente
  if (currentWines.some(w => w.id === carloMagno.id || w.name === "Carlo Magno")) {
    console.log("Carlo Magno è già presente in production, nessuna modifica necessaria.");
    return;
  }

  // 3. Aggiungi Carlo Magno e salva
  const newList = [...currentWines, carloMagno];
  const resp = await fetch(apiBase, {
    method: "POST",
    headers: { ...headers, "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: "wines", value: newList }),
  });

  if (resp.ok) {
    console.log(`✅ Carlo Magno recuperato con successo. Totale vini: ${newList.length}`);
  } else {
    const err = await resp.text();
    console.error("Errore salvataggio:", err);
  }
}

main().catch(console.error);
