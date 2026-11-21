import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    {
      name: 'desktop-cloud-config',
      generateBundle() {
        const { VITE_SUPABASE_URL } = loadEnv(mode, process.cwd(), 'VITE_')
        this.emitFile({ type: 'asset', fileName: 'desktop-cloud.json', source: JSON.stringify({ url: VITE_SUPABASE_URL || '' }) })
      },
    },
  ],
  server: { watch: { ignored: ['**/release/**'] } },
}))
