import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * GitHub project Pages serves the site at /<repo>/.
 * - Local dev: base '/' (default).
 * - GitHub Actions: GITHUB_REPOSITORY is set (e.g. owner/haptic_tester) — use /<repo>/.
 * - Override anytime: VITE_BASE=/my-repo/
 */
function resolveBase(): string {
  const explicit = process.env.VITE_BASE?.trim()
  if (explicit) {
    return explicit.endsWith('/') ? explicit : `${explicit}/`
  }
  const gh = process.env.GITHUB_REPOSITORY
  if (gh) {
    const name = gh.split('/')[1]
    if (name) return `/${name}/`
  }
  return '/'
}

export default defineConfig({
  plugins: [react()],
  base: resolveBase(),
})
