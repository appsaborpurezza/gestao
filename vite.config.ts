import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function buildVersion() {
  const sha = process.env.GITHUB_SHA?.slice(0, 7)
  if (sha) return sha
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return 'dev' }
}

export default defineConfig({
  base: '/gestao/',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(buildVersion()) },
})
