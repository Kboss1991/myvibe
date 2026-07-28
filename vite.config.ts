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
      includeAssets: [
        'favicon.ico',
        'favicon.png',
        'apple-touch-icon.png',
        'apple-touch-icon-precomposed.png',
        'icons/*.png',
      ],
      manifest: {
        name: 'MyVibe',
        short_name: 'MyVibe',
        description: 'Tu música local, sin anuncios.',
        theme_color: '#121212',
        background_color: '#121212',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        id: '/',
        // Ayuda a iOS/Android a tratar la PWA como app de música
        categories: ['music', 'entertainment'],
        icons: [
          {
            src: 'icons/icon-192-v4.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512-v4.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512-v4.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Sube esto cuando la UI no se actualice en el móvil (caché PWA)
        cacheId: 'myvibe-my-radios-browser-20260729',
        globPatterns: ['**/*.{js,css,html,ico,svg,woff2,png}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: '/index.html',
        // Never treat JS/CSS/assets as SPA navigations (avoids HTML MIME errors).
        navigateFallbackDenylist: [
          /^\/api/,
          /^\/assets\//,
          /\/assets\//,
          /\.[a-zA-Z0-9]+$/,
        ],
      },
    }),
  ],
})
