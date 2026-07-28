import { db, REMEMBER_EMAIL_KEY, SESSION_KEY } from '../db'
import type { User } from '../types'
import {
  bytesToHex as pbkdf2BytesToHex,
  hexToBytes as pbkdf2HexToBytes,
  pbkdf2Sha256,
} from './pbkdf2'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PBKDF2_ITERATIONS = 120_000

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return pbkdf2BytesToHex(arr)
}

function hexToBytes(hex: string): Uint8Array {
  return pbkdf2HexToBytes(hex)
}

function hasSubtle(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle
}

async function deriveKey(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder()
  const passwordBytes = enc.encode(password)
  const salt = hexToBytes(saltHex)

  if (hasSubtle()) {
    try {
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        passwordBytes,
        'PBKDF2',
        false,
        ['deriveBits'],
      )
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: salt as BufferSource,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256',
        },
        keyMaterial,
        256,
      )
      return bytesToHex(bits)
    } catch {
      // cae al polyfill (p. ej. HTTP en IP de la LAN)
    }
  }

  // Yield para no congelar el UI en móvil (120k iteraciones)
  await new Promise((r) => setTimeout(r, 0))
  const derived = await pbkdf2Sha256(passwordBytes, salt, PBKDF2_ITERATIONS, 256)
  return bytesToHex(derived)
}

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytesToHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isAuthCryptoReady(): boolean {
  // Con polyfill siempre podemos hashear; solo avisamos si no hay storage
  try {
    const k = '__myvibe_probe__'
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    return true
  } catch {
    return false
  }
}

export function isInsecureLanContext(): boolean {
  if (typeof window === 'undefined') return false
  if (window.isSecureContext) return false
  const host = window.location.hostname
  return host !== 'localhost' && host !== '127.0.0.1'
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function validateEmail(email: string): boolean {
  return EMAIL_RE.test(normalizeEmail(email))
}

async function findUserByLogin(login: string): Promise<User | undefined> {
  const clean = normalizeEmail(login)
  const byEmail = await db.users.where('email').equals(clean).first()
  if (byEmail) return byEmail
  // Compat: cuentas antiguas creadas solo con "usuario"
  return db.users.where('username').equals(clean).first()
}

function persistSession(user: User, remember: boolean) {
  localStorage.setItem(SESSION_KEY, user.id)
  if (remember) {
    localStorage.setItem(REMEMBER_EMAIL_KEY, user.email || user.username)
  } else {
    localStorage.removeItem(REMEMBER_EMAIL_KEY)
  }
}

export async function registerUser(
  email: string,
  password: string,
  displayName: string,
  remember = true,
): Promise<User> {
  const clean = normalizeEmail(email)
  if (!validateEmail(clean)) throw new Error('Introduce un correo válido')
  if (password.length < 4) throw new Error('La contraseña debe tener al menos 4 caracteres')

  const existing = await findUserByLogin(clean)
  if (existing) throw new Error('Ya hay una cuenta con ese correo')

  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = bytesToHex(saltBytes)
  const passwordHash = await deriveKey(password, salt)
  const localPart = clean.split('@')[0]

  const user: User = {
    id: createId(),
    email: clean,
    username: localPart,
    displayName: displayName.trim() || localPart,
    passwordHash,
    salt,
    avatarHue: Math.floor(Math.random() * 360),
    hasAvatar: false,
    createdAt: Date.now(),
    bio: '',
  }
  await db.users.put(user)
  persistSession(user, remember)
  return user
}

export async function loginUser(
  email: string,
  password: string,
  remember = true,
): Promise<User> {
  const clean = normalizeEmail(email)
  const user = await findUserByLogin(clean)
  if (!user) throw new Error('Correo o contraseña incorrectos')

  const hash = await deriveKey(password, user.salt)
  if (hash !== user.passwordHash) throw new Error('Correo o contraseña incorrectos')

  // Asegura campo email en cuentas antiguas
  if (!user.email) {
    const emailValue = clean.includes('@') ? clean : `${user.username}@local.myvibe`
    await db.users.update(user.id, { email: emailValue })
    user.email = emailValue
  }

  persistSession(user, remember)
  return user
}

export function logoutUser(): void {
  localStorage.removeItem(SESSION_KEY)
  // Mantiene el correo recordado para rellenar el formulario
}

export function getRememberedEmail(): string {
  return localStorage.getItem(REMEMBER_EMAIL_KEY) ?? ''
}

export async function getSessionUser(): Promise<User | null> {
  const id = localStorage.getItem(SESSION_KEY)
  if (!id) return null
  const user = await db.users.get(id)
  if (!user) {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
  return user
}

export async function updateProfile(
  userId: string,
  patch: Partial<Pick<User, 'displayName' | 'bio' | 'avatarHue' | 'email'>>,
): Promise<void> {
  await db.users.update(userId, patch)
}

export function avatarCoverId(userId: string): string {
  return `avatar:${userId}`
}

async function normalizeAvatarBlob(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Elige una imagen (JPG, PNG, WebP…)')
  }
  try {
    const bitmap = await createImageBitmap(file)
    const max = 512
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.88),
    )
    return blob || file
  } catch {
    return file
  }
}

export async function setUserAvatar(userId: string, file: File): Promise<User> {
  const { saveCoverBlob, revokeCachedUrls } = await import('./library')
  const user = await db.users.get(userId)
  if (!user) throw new Error('Sesión no válida')

  const id = avatarCoverId(userId)
  const blob = await normalizeAvatarBlob(file)
  revokeCachedUrls(id)
  await saveCoverBlob(id, blob)
  const avatarUpdatedAt = Date.now()
  await db.users.update(userId, { hasAvatar: true, avatarUpdatedAt })
  const updated = await db.users.get(userId)
  if (!updated) throw new Error('No se pudo guardar el avatar')
  return updated
}

export async function clearUserAvatar(userId: string): Promise<User> {
  const { revokeCachedUrls } = await import('./library')
  const { deleteBinary } = await import('./opfs')
  const user = await db.users.get(userId)
  if (!user) throw new Error('Sesión no válida')

  const id = avatarCoverId(userId)
  revokeCachedUrls(id)
  await deleteBinary('covers', id)
  await db.covers.delete(id)
  const avatarUpdatedAt = Date.now()
  await db.users.update(userId, { hasAvatar: false, avatarUpdatedAt })
  const updated = await db.users.get(userId)
  if (!updated) throw new Error('No se pudo quitar el avatar')
  return updated
}

export function hasRealEmail(user: User): boolean {
  return (
    Boolean(user.email) &&
    validateEmail(user.email) &&
    !user.email.endsWith('@local.myvibe')
  )
}

export async function setUserEmail(userId: string, email: string): Promise<User> {
  const clean = normalizeEmail(email)
  if (!validateEmail(clean)) throw new Error('Introduce un correo válido')

  const user = await db.users.get(userId)
  if (!user) throw new Error('Sesión no válida')

  const taken = await db.users.where('email').equals(clean).first()
  if (taken && taken.id !== userId) {
    throw new Error('Ya hay una cuenta con ese correo')
  }

  const localPart = clean.split('@')[0]
  await db.users.update(userId, {
    email: clean,
    username: localPart || user.username,
  })

  const remembered = localStorage.getItem(REMEMBER_EMAIL_KEY)
  if (remembered) {
    localStorage.setItem(REMEMBER_EMAIL_KEY, clean)
  }

  const updated = await db.users.get(userId)
  if (!updated) throw new Error('No se pudo guardar el correo')
  return updated
}

export async function changePassword(userId: string, newPassword: string): Promise<void> {
  if (newPassword.length < 4) {
    throw new Error('La nueva contraseña debe tener al menos 4 caracteres')
  }

  const user = await db.users.get(userId)
  if (!user) throw new Error('Sesión no válida')

  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = bytesToHex(saltBytes)
  const passwordHash = await deriveKey(newPassword, salt)
  await db.users.update(userId, { salt, passwordHash })
}

export async function countUsers(): Promise<number> {
  return db.users.count()
}
