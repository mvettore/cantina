import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

function getVersion() {
  try {
    const count = execSync('git rev-list --count HEAD').toString().trim()
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    const date = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return `v${count} · ${sha} · ${date}`
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(getVersion()),
  },
})
