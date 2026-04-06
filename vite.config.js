import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

function getVersion() {
  try {
    const count = execSync('git rev-list --count HEAD').toString().trim()
    const sha = execSync('git rev-parse --short HEAD').toString().trim()
    return `v${count} · ${sha}`
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
