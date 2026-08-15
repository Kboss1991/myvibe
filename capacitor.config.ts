import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Shell nativo (iOS/Android) sobre el build Vite (`dist`).
 * Web/PWA en Vercel no usa este archivo.
 */
const config: CapacitorConfig = {
  appId: 'app.myvibe.music',
  appName: 'MyVibe',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#121212',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#121212',
    },
  },
}

export default config
