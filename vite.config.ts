import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  server: {
    port: 5174,
    strictPort: true,
    host: true,
    proxy: {
      '/api/deezer': {
        target: 'https://api.deezer.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/deezer/, ''),
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'MyVibe',
        short_name: 'MyVibe',
        description: 'Tu música local, sin anuncios. Escucha en el coche.',
        theme_color: '#121212',
        background_color: '#121212',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2,png}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
})
