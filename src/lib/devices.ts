import { getSupabase, isCloudAuthEnabled } from './supabase'
import { isAppleMobile, isLibraryHostCapable } from './folderImport'

const DEVICE_ID_KEY = 'myvibe_device_id'
const HOST_PREF_KEY = 'myvibe_library_host'
const HOST_DEVICE_KEY = 'myvibe_library_host_device_id'

export type DeviceKind = 'pc' | 'mobile' | 'tablet'

export type UserDevice = {
  id: string
  label: string
  kind: DeviceKind
  isLibraryHost: boolean
  lastSeen: number
  revokedAt: number | null
  isThisDevice: boolean
}

export function getLocalDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

export function detectDeviceKind(): DeviceKind {
  if (typeof navigator === 'undefined') return 'pc'
  if (isAppleMobile()) {
    const ua = navigator.userAgent || ''
    if (/iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      return 'tablet'
    }
    return 'mobile'
  }
  const ua = navigator.userAgent || ''
  if (/Android/i.test(ua)) {
    return /Mobile/i.test(ua) ? 'mobile' : 'tablet'
  }
  if (/Mobile/i.test(ua)) return 'mobile'
  return 'pc'
}

export function defaultDeviceLabel(kind: DeviceKind = detectDeviceKind()): string {
  if (kind === 'mobile') return 'Móvil'
  if (kind === 'tablet') return 'Tablet'
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows/i.test(ua)) return 'PC Windows'
  if (/Mac/i.test(ua)) return 'Mac'
  if (/Linux/i.test(ua)) return 'PC Linux'
  return 'PC'
}

/** Preferencia local: ¿este dispositivo reclama ser la biblioteca principal? */
export function getLocalHostPreference(): boolean | null {
  const v = localStorage.getItem(HOST_PREF_KEY)
  if (v === '1') return true
  if (v === '0') return false
  return null
}

export function setLocalHostPreference(on: boolean) {
  localStorage.setItem(HOST_PREF_KEY, on ? '1' : '0')
  if (on) localStorage.setItem(HOST_DEVICE_KEY, getLocalDeviceId())
}

export function getCachedHostDeviceId(): string | null {
  return localStorage.getItem(HOST_DEVICE_KEY)
}

export function setCachedHostDeviceId(id: string | null) {
  if (id) localStorage.setItem(HOST_DEVICE_KEY, id)
  else localStorage.removeItem(HOST_DEVICE_KEY)
}

/**
 * ¿Este dispositivo actúa como biblioteca principal?
 * Solo PCs capaces; respeta preferencia local y quién está marcado en nube.
 */
export function isLibraryHostDevice(): boolean {
  if (!isLibraryHostCapable()) return false
  const pref = getLocalHostPreference()
  if (pref === false) return false
  if (pref === true) return true
  const hostId = getCachedHostDeviceId()
  if (hostId && hostId !== getLocalDeviceId()) return false
  return true
}

export async function heartbeatDevice(userId: string): Promise<{ revoked: boolean }> {
  const id = getLocalDeviceId()
  const kind = detectDeviceKind()
  const label = defaultDeviceLabel(kind)

  if (!isCloudAuthEnabled()) {
    return { revoked: false }
  }

  const sb = getSupabase()
  const { data: existing } = await sb
    .from('user_devices')
    .select('revoked_at, is_library_host')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle()

  if (existing?.revoked_at) {
    return { revoked: true }
  }

  const wantHost = isLibraryHostCapable() && (getLocalHostPreference() ?? true)
  const row = {
    id,
    user_id: userId,
    label,
    kind,
    is_library_host: wantHost,
    last_seen: new Date().toISOString(),
    revoked_at: null,
  }

  const { error } = await sb.from('user_devices').upsert(row, { onConflict: 'user_id,id' })
  if (error) throw error

  if (wantHost) {
    await sb
      .from('user_devices')
      .update({ is_library_host: false })
      .eq('user_id', userId)
      .neq('id', id)
    setCachedHostDeviceId(id)
    setLocalHostPreference(true)
  } else {
    const { data: hosts } = await sb
      .from('user_devices')
      .select('id')
      .eq('user_id', userId)
      .eq('is_library_host', true)
      .is('revoked_at', null)
      .limit(1)
    setCachedHostDeviceId(hosts?.[0]?.id ?? null)
  }

  return { revoked: false }
}

export async function listDevices(userId: string): Promise<UserDevice[]> {
  const myId = getLocalDeviceId()
  if (!isCloudAuthEnabled()) {
    const kind = detectDeviceKind()
    return [
      {
        id: myId,
        label: defaultDeviceLabel(kind),
        kind,
        isLibraryHost: isLibraryHostDevice(),
        lastSeen: Date.now(),
        revokedAt: null,
        isThisDevice: true,
      },
    ]
  }

  const sb = getSupabase()
  const { data, error } = await sb
    .from('user_devices')
    .select('id, label, kind, is_library_host, last_seen, revoked_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen', { ascending: false })

  if (error) throw error

  const host = (data ?? []).find((d) => d.is_library_host)
  if (host) setCachedHostDeviceId(host.id)

  return (data ?? []).map((d) => ({
    id: d.id as string,
    label: (d.label as string) || 'Dispositivo',
    kind: (d.kind as DeviceKind) || 'pc',
    isLibraryHost: Boolean(d.is_library_host),
    lastSeen: Date.parse(d.last_seen as string) || Date.now(),
    revokedAt: d.revoked_at ? Date.parse(d.revoked_at as string) : null,
    isThisDevice: d.id === myId,
  }))
}

export async function revokeDevice(userId: string, deviceId: string): Promise<void> {
  if (!isCloudAuthEnabled()) {
    throw new Error('Cerrar sesión remota requiere la nube (Supabase)')
  }
  if (deviceId === getLocalDeviceId()) {
    throw new Error('Usa «Cerrar sesión» para este dispositivo')
  }
  const sb = getSupabase()
  const { error } = await sb
    .from('user_devices')
    .update({ revoked_at: new Date().toISOString(), is_library_host: false })
    .eq('user_id', userId)
    .eq('id', deviceId)
  if (error) throw error
}

export async function claimLibraryHost(userId: string): Promise<void> {
  if (!isLibraryHostCapable()) {
    throw new Error('Solo un PC puede ser la biblioteca principal')
  }
  setLocalHostPreference(true)
  if (!isCloudAuthEnabled()) {
    setCachedHostDeviceId(getLocalDeviceId())
    return
  }
  await heartbeatDevice(userId)
}

export async function clearLibraryHostClaim(): Promise<void> {
  setLocalHostPreference(false)
  if (!isCloudAuthEnabled()) {
    setCachedHostDeviceId(null)
    return
  }
  const userId = (await getSupabase().auth.getUser()).data.user?.id
  if (!userId) return
  const id = getLocalDeviceId()
  await getSupabase()
    .from('user_devices')
    .update({ is_library_host: false })
    .eq('user_id', userId)
    .eq('id', id)
  setCachedHostDeviceId(null)
}

export function formatLastSeen(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'Ahora'
  if (diff < 3_600_000) return `Hace ${Math.floor(diff / 60_000)} min`
  if (diff < 86_400_000) return `Hace ${Math.floor(diff / 3_600_000)} h`
  return new Date(ts).toLocaleString('es', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
