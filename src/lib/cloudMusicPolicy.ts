/**
 * Opción D: la música (catálogo, me gusta, playlists) no se registra en Supabase.
 * La nube solo sirve para cuenta, peer Wi‑Fi (device_peers) y podcasts.
 * PC → móvil: biblioteca completa por Wi‑Fi local (PeerJS).
 */
export function isCloudMusicSyncEnabled(): boolean {
  return false
}
