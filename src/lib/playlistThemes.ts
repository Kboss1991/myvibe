/** Paleta de fondos para playlists (gradiente hacia #121212). */
export const PLAYLIST_THEME_COLORS = [
  '#3a4a38',
  '#8a6a2a',
  '#c45c26',
  '#2f5d50',
  '#1e4a6e',
  '#6b3a3a',
  '#3d3d4a',
  '#5a4a2a',
  '#2a4a3a',
  '#4a3528',
] as const

export const DEFAULT_PLAYLIST_THEME = PLAYLIST_THEME_COLORS[0]

const HEX_RE = /^#([0-9a-f]{6})$/i

/** Normaliza a #rrggbb o null si no es válido. */
export function normalizeThemeColor(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.trim()
  if (!HEX_RE.test(v)) return null
  return `#${v.slice(1).toLowerCase()}`
}

export function pickDefaultThemeColor(): string {
  const i = Math.floor(Math.random() * PLAYLIST_THEME_COLORS.length)
  return PLAYLIST_THEME_COLORS[i]!
}
