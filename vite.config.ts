import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub project Pages: set VITE_BASE=/your-repo/ in CI (default /haptic_tester/)
const base = process.env.VITE_BASE ?? '/'

export default defineConfig({
  plugins: [react()],
  base: base.endsWith('/') ? base : `${base}/`,
})
