import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'

/** Arranque del shell nativo (no-op en web/PWA). */
export async function initNativeShell(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  try {
    await StatusBar.setStyle({ style: Style.Dark })
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: '#121212' })
    }
  } catch {
    /* plugin no disponible en web preview */
  }

  try {
    await SplashScreen.hide()
  } catch {
    /* ignore */
  }

  // Android: atrás cierra hojas / historial antes de salir de la app
  void CapApp.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) {
      window.history.back()
      return
    }
    void CapApp.exitApp()
  })
}

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}
