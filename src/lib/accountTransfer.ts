import { db, REMEMBER_EMAIL_KEY, SESSION_KEY } from '../db'
import type { User } from '../types'
import { avatarCoverId } from './auth'
import { getCoverBlob, revokeCachedUrls, saveCoverBlob } from './library'
import type { ZipEntry } from './zip'
import { buildZipBlob, extractZipEntries, isZipFile } from './zip'

export const ACCOUNT_JSON = 'myvibe-account.json'
export const ACCOUNT_AVATAR = 'myvibe-avatar.jpg'
export const ACCOUNT_EXT = '.myvibe-account'
export const ACCOUNT_MIME = 'application/x-myvibe-account+json'

const ACCOUNT_VERSION = 1 as const

export interface ExportedAccount {
  v: typeof ACCOUNT_VERSION
  kind: 'account'
  exportedAt: number
  user: {
    id: string
    email: string
    username: string
    displayName: string
    passwordHash: string
    salt: string
    avatarHue: number
    hasAvatar: boolean
    bio: string
    createdAt: number
  }
  /** Avatar en base64 (jpeg), opcional */
  avatarBase64?: string | null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export function isAccountTransferFile(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith(ACCOUNT_EXT) || name.endsWith('.myvibe-account.json')
}

export async function buildAccountExport(userId: string): Promise<ExportedAccount> {
  const user = await db.users.get(userId)
  if (!user) throw new Error('No hay cuenta para exportar')

  let avatarBase64: string | null = null
  if (user.hasAvatar) {
    const blob = await getCoverBlob(avatarCoverId(user.id))
    if (blob) {
      avatarBase64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
    }
  }

  return {
    v: ACCOUNT_VERSION,
    kind: 'account',
    exportedAt: Date.now(),
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      salt: user.salt,
      avatarHue: user.avatarHue,
      hasAvatar: Boolean(user.hasAvatar && avatarBase64),
      bio: user.bio || '',
      createdAt: user.createdAt,
    },
    avatarBase64,
  }
}

export async function accountZipEntries(userId: string): Promise<ZipEntry[]> {
  const pack = await buildAccountExport(userId)
  const enc = new TextEncoder()
  const entries: ZipEntry[] = [
    {
      name: ACCOUNT_JSON,
      data: enc.encode(JSON.stringify(pack)),
    },
  ]
  if (pack.avatarBase64) {
    entries.push({
      name: ACCOUNT_AVATAR,
      data: base64ToBytes(pack.avatarBase64),
    })
  }
  return entries
}

function parseAccountPayload(raw: unknown): ExportedAccount {
  if (!raw || typeof raw !== 'object') throw new Error('Cuenta inválida')
  const data = raw as Partial<ExportedAccount>
  if (data.v !== ACCOUNT_VERSION || data.kind !== 'account' || !data.user) {
    throw new Error('Archivo de cuenta MyVibe no válido')
  }
  const u = data.user
  if (!u.email || !u.passwordHash || !u.salt || !u.id) {
    throw new Error('La cuenta exportada está incompleta')
  }
  return data as ExportedAccount
}

async function applyAccount(
  pack: ExportedAccount,
  avatarBytes?: Uint8Array | null,
): Promise<User> {
  const incoming = pack.user
  const email = incoming.email.trim().toLowerCase()

  // Si ya hay usuario con ese correo u otro con el mismo id, unificar
  const byEmail = await db.users.where('email').equals(email).first()
  const byId = await db.users.get(incoming.id)
  const targetId = byEmail?.id || byId?.id || incoming.id

  // Si otro usuario distinto ocupa el email, lo reemplazamos (transferencia del mismo dueño)
  if (byEmail && byEmail.id !== targetId) {
    await db.users.delete(byEmail.id)
  }

  const user: User = {
    id: targetId,
    email,
    username: incoming.username || email.split('@')[0],
    displayName: incoming.displayName || email.split('@')[0],
    passwordHash: incoming.passwordHash,
    salt: incoming.salt,
    avatarHue: incoming.avatarHue ?? 200,
    hasAvatar: false,
    avatarUpdatedAt: Date.now(),
    bio: incoming.bio || '',
    createdAt: incoming.createdAt || Date.now(),
  }

  const avatarId = avatarCoverId(user.id)
  const fromPack =
    avatarBytes ||
    (pack.avatarBase64 ? base64ToBytes(pack.avatarBase64) : null)

  if (fromPack && fromPack.length) {
    revokeCachedUrls(avatarId)
    await saveCoverBlob(avatarId, new Blob([fromPack as BlobPart], { type: 'image/jpeg' }))
    user.hasAvatar = true
  } else {
    user.hasAvatar = false
  }

  await db.users.put(user)
  localStorage.setItem(SESSION_KEY, user.id)
  localStorage.setItem(REMEMBER_EMAIL_KEY, user.email)
  return user
}

export async function importAccountFromJsonFile(file: File): Promise<User> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('No se pudo leer el archivo de cuenta')
  }
  return applyAccount(parseAccountPayload(parsed))
}

export async function importAccountFromZip(file: File): Promise<User | null> {
  const entries = await extractZipEntries(file)
  const jsonEntry = entries.find(
    (e) =>
      e.name === ACCOUNT_JSON ||
      e.name.endsWith(`/${ACCOUNT_JSON}`) ||
      e.name.toLowerCase().endsWith('myvibe-account.json'),
  )
  if (!jsonEntry) return null

  const text = new TextDecoder().decode(jsonEntry.data)
  const pack = parseAccountPayload(JSON.parse(text))
  const avatarEntry = entries.find(
    (e) =>
      e.name === ACCOUNT_AVATAR ||
      e.name.endsWith(`/${ACCOUNT_AVATAR}`) ||
      /myvibe-avatar\.(jpe?g|png|webp)$/i.test(e.name),
  )
  return applyAccount(pack, avatarEntry?.data)
}

/** Importa cuenta desde .myvibe-account, ZIP de biblioteca o JSON suelto. */
export async function importAccountTransfer(file: File): Promise<User> {
  if (isZipFile(file)) {
    const user = await importAccountFromZip(file)
    if (!user) throw new Error('Este ZIP no incluye una cuenta MyVibe')
    return user
  }
  if (isAccountTransferFile(file) || file.type.includes('json')) {
    return importAccountFromJsonFile(file)
  }
  throw new Error('Elige un ZIP de MyVibe o un archivo de cuenta (.myvibe-account)')
}

export async function downloadAccountZip(userId: string): Promise<'downloaded'> {
  const entries = await accountZipEntries(userId)
  const zip = buildZipBlob(entries)
  const file = new File([zip], 'mi-cuenta-myvibe.zip', { type: 'application/zip' })
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return 'downloaded'
}
