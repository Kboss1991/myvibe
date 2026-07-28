import QRCode from 'qrcode'

/** URL que el móvil abre al escanear el QR (recibe e importa a la biblioteca). */
export function buildReceiveUrl(code: string, origin = window.location.origin): string {
  const clean = code.replace(/\D/g, '').slice(0, 6)
  const url = new URL('/receive', origin)
  url.searchParams.set('code', clean)
  return url.toString()
}

export async function receiveQrDataUrl(code: string, origin?: string): Promise<string> {
  return QRCode.toDataURL(buildReceiveUrl(code, origin), {
    width: 280,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#121212', light: '#ffffff' },
  })
}

export function isLocalhostHost(hostname = window.location.hostname): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}
