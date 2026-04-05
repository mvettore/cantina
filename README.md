# 🍷 La Mia Cantina

App per catalogare i vini della tua cantina con riconoscimento automatico delle etichette.

---

## Sviluppo locale

```bash
npm install
```

Crea un file `.env.local` nella radice del progetto:

```
VITE_ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
```

Ottieni la tua chiave su https://console.anthropic.com

Avvia il server di sviluppo:

```bash
npm run dev
# → http://localhost:5173
```

---

## Deploy su Netlify

### 1. Prepara il repository

```bash
git init
git add .
git commit -m "first commit"
```

Crea un repository su GitHub e caricaci il codice:

```bash
git remote add origin https://github.com/TUO_UTENTE/cantina.git
git push -u origin main
```

### 2. Collega Netlify

1. Vai su [netlify.com](https://netlify.com) → **Add new site** → **Import an existing project**
2. Seleziona il tuo repository GitHub
3. Le impostazioni di build vengono rilevate automaticamente da `netlify.toml`:
   - **Build command:** `npm run build`
   - **Publish directory:** `dist`

### 3. Aggiungi la chiave API (⚠️ passaggio fondamentale)

Nella dashboard Netlify del tuo sito:

**Site configuration → Environment variables → Add a variable**

```
Key:   ANTHROPIC_API_KEY
Value: sk-ant-xxxxxxxxxxxxxxxx
```

> La chiave viene salvata in modo sicuro sul server Netlify.
> Non finirà mai nel codice o nel browser.

### 4. Deploy

Clicca **Deploy site**. Da questo momento ogni `git push` farà un deploy automatico.

---

## Come funziona il riconoscimento etichette

```
Telefono                  Netlify Function              Anthropic API
   │                           │                              │
   │  foto (base64) ──────────>│                              │
   │                           │  richiesta + chiave API ──> │
   │                           │              analisi AI     │
   │                           │  risposta JSON <─────────── │
   │  dati vino <──────────────│                              │
```

La chiave API non lascia mai il server Netlify.

---

## Struttura del progetto

```
cantina/
├── netlify/
│   └── functions/
│       └── scan-label.js   ← backend proxy (gira su Netlify)
├── src/
│   ├── App.jsx             ← tutta l'app React
│   └── main.jsx
├── index.html
├── netlify.toml            ← configurazione Netlify
├── package.json
└── vite.config.js
```
