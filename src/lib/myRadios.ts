import { RADIO_SEED_STATIONS, type RadioStation } from './radios'

export type { RadioStation }

const STORAGE_KEY = 'myvibe_my_radios'

type Listener = () => void
const listeners = new Set<Listener>()

/** Snapshot estable para useSyncExternalStore (misma referencia si no cambia). */
let cachedList: RadioStation[] | null = null
let cachedRaw: string | null = null

function emit() {
  for (const l of listeners) l()
}

export function subscribeMyRadios(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
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

function parseList(raw: string): RadioStation[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidStation)
  } catch {
    return []
  }
}

function readSnapshot(): RadioStation[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    raw = null
  }

  if (raw == null) {
    // Primera visita: sembrar sin emitir (getSnapshot debe ser puro)
    const seeded = RADIO_SEED_STATIONS.map((s) => ({ ...s }))
    const serialized = JSON.stringify(seeded)
    try {
      localStorage.setItem(STORAGE_KEY, serialized)
    } catch {
      // ignore quota
    }
    cachedRaw = serialized
    cachedList = seeded
    return cachedList
  }

  if (raw === cachedRaw && cachedList) return cachedList

  cachedRaw = raw
  cachedList = parseList(raw)
  return cachedList
}

function write(stations: RadioStation[]) {
  const serialized = JSON.stringify(stations)
  try {
    localStorage.setItem(STORAGE_KEY, serialized)
  } catch {
    // ignore quota
  }
  cachedRaw = serialized
  cachedList = stations
  emit()
}

/**
 * Lista cacheada: misma referencia entre lecturas si no ha cambiado.
 * Obligatorio para useSyncExternalStore (React #185).
 */
export function listMyRadios(): RadioStation[] {
  return readSnapshot()
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
