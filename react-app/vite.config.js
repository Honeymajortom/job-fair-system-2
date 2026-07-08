import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// v3.0 §10: one SPA, vendor-react / vendor-motion split so the public chunk
// stays light. Dev proxy keeps the API + socket same-origin (HttpOnly cookie).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/framer-motion') || id.includes('node_modules/motion')) return 'vendor-motion';
          if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'vendor-react';
        },
      },
    },
  },
})
