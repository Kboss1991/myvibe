import { RADIO_SEED_STATIONS, type RadioStation } from './radios'

export type { RadioStation }

const STORAGE_KEY = 'myvibe_my_radios'

type Listener = () => void
const listeners = new Set<Listener>()

function emit() {
  for (const l of listeners) l()
}

export function subscribeMyRadios(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readRaw(): RadioStation[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw == null) return null
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidStation)
  } catch {
    return []
  }
}

function isValidStation(value: unknown): value is RadioStation {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.name === 'string' &&
    typeof s.streamUrl === 'string' &&
    typeof s.tagline === 'string' &&
    typeof s.logoUrl === 'string' &&
    (s.group === 'catalunya' || s.group === 'espana' || s.group === 'world')
  )
}

function write(stations: RadioStation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stations))
  } catch {
    // ignore quota
  }
  emit()
}

/** Primera visita: si no hay clave, siembra el catálogo local. `[]` del usuario no se vuelve a sembrar. */
function ensureSeeded(): RadioStation[] {
  const existing = readRaw()
  if (existing != null) return existing
  const seeded = RADIO_SEED_STATIONS.map((s) => ({ ...s }))
  write(seeded)
  return seeded
}

export function listMyRadios(): RadioStation[] {
  return ensureSeeded()
}

export function getMyRadio(id: string | null | undefined): RadioStation | null {
  if (!id) return null
  return listMyRadios().find((s) => s.id === id) ?? null
}

/** Resuelve emisora desde Mis radios (o semilla si aún no está en la lista). */
export function getRadioStation(id: string | null | undefined): RadioStation | null {
  if (!id) return null
  return getMyRadio(id) ?? RADIO_SEED_STATIONS.find((s) => s.id === id) ?? null
}

export function hasMyRadio(id: string): boolean {
  return listMyRadios().some((s) => s.id === id)
}

export function addMyRadio(station: RadioStation): void {
  const list = listMyRadios()
  if (list.some((s) => s.id === station.id)) return
  write([{ ...station }, ...list])
}

export function removeMyRadio(id: string): void {
  write(listMyRadios().filter((s) => s.id !== id))
}
