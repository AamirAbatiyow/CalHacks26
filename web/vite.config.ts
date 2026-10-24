import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // The globe reads station antennas and satellite bands from server/fixtures.
    fs: { allow: ['..'] },
  },
  build: {
    target: 'esnext',
  },
  define: {
    global: 'globalThis',
  },
})
