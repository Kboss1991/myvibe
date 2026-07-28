import { db, REMEMBER_EMAIL_KEY, SESSION_KEY } from '../db'
import type { User } from '../types'
import {
  bytesToHex as pbkdf2BytesToHex,
  hexToBytes as pbkdf2HexToBytes,
  pbkdf2Sha256,
} from './pbkdf2'
import { getSupabase, isCloudAuthEnabled } from './supabase'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PBKDF2_ITERATIONS = 120_000

export { isCloudAuthEnabled }

type ProfileRow = {
  id: string
  email: string | null
  display_name: string
  bio: string
  avatar_hue: number
  has_avatar: boolean
  avatar_updated_at: number | null
  created_at: string
}

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

function mapAuthError(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login') || m.includes('invalid credentials')) {
    return 'Correo o contraseña incorrectos'
  }
  if (m.includes('already registered') || m.includes('user already')) {
    return 'Ya hay una cuenta con ese correo'
  }
  if (m.includes('password') && m.includes('6')) {
    return 'La contraseña debe tener al menos 6 caracteres'
  }
  if (m.includes('email')) {
    return 'Revisa el correo electrónico'
  }
  return message || 'Error de autenticación'
}

function profileToUser(profile: ProfileRow, emailFallback?: string): User {
  const email = (profile.email || emailFallback || '').toLowerCase()
  const localPart = email.includes('@') ? email.split('@')[0]! : email || 'user'
  return {
    id: profile.id,
    email,
    username: localPart,
    displayName: profile.display_name || localPart,
    passwordHash: '',
    salt: '',
    avatarHue: profile.avatar_hue ?? 0,
    hasAvatar: Boolean(profile.has_avatar),
    avatarUpdatedAt: profile.avatar_updated_at ?? undefined,
    createdAt: profile.created_at ? Date.parse(profile.created_at) : Date.now(),
    bio: profile.bio || '',
  }
}

async function fetchProfile(userId: string, emailFallback?: string): Promise<User> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw new Error(mapAuthError(error.message))

  if (!data) {
    const email = emailFallback || ''
    const localPart = email.split('@')[0] || 'user'
    const row = {
      id: userId,
      email,
      display_name: localPart,
      bio: '',
      avatar_hue: Math.floor(Math.random() * 360),
      has_avatar: false,
      avatar_updated_at: null,
    }
    const { error: insertError } = await supabase.from('profiles').upsert(row)
    if (insertError) throw new Error(mapAuthError(insertError.message))
    return profileToUser({ ...row, created_at: new Date().toISOString() }, email)
  }

  const user = profileToUser(data as ProfileRow, emailFallback)
  if (user.hasAvatar) {
    await cacheCloudAvatar(user.id)
  }
  return user
}

export function avatarCoverId(userId: string): string {
  return `avatar:${userId}`
}

function avatarStoragePath(userId: string): string {
  return `${userId}/avatar.jpg`
}

async function cacheCloudAvatar(userId: string): Promise<void> {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase.storage
      .from('avatars')
      .download(avatarStoragePath(userId))
    if (error || !data) return
    const { saveCoverBlob, revokeCachedUrls } = await import('./library')
    const id = avatarCoverId(userId)
    revokeCachedUrls(id)
    await saveCoverBlob(id, data)
  } catch {
    // avatar opcional
  }
}

function rememberEmail(email: string, remember: boolean) {
  if (remember) localStorage.setItem(REMEMBER_EMAIL_KEY, email)
  else localStorage.removeItem(REMEMBER_EMAIL_KEY)
}

function persistLocalSession(user: User, remember: boolean) {
  localStorage.setItem(SESSION_KEY, user.id)
  rememberEmail(user.email || user.username, remember)
}

async function findUserByLogin(login: string): Promise<User | undefined> {
  const clean = normalizeEmail(login)
  const byEmail = await db.users.where('email').equals(clean).first()
  if (byEmail) return byEmail
  return db.users.where('username').equals(clean).first()
}

export async function registerUser(
  email: string,
  password: string,
  displayName: string,
  remember = true,
): Promise<User> {
  const clean = normalizeEmail(email)
  if (!validateEmail(clean)) throw new Error('Introduce un correo válido')

  if (isCloudAuthEnabled()) {
    if (password.length < 6) {
      throw new Error('La contraseña debe tener al menos 6 caracteres')
    }
    const supabase = getSupabase()
    const localPart = clean.split('@')[0]!
    const name = displayName.trim() || localPart
    const { data, error } = await supabase.auth.signUp({
      email: clean,
      password,
      options: { data: { display_name: name } },
    })
    if (error) throw new Error(mapAuthError(error.message))
    if (!data.user) throw new Error('No se pudo crear la cuenta')

    // Si el proyecto exige confirmar email, puede no haber session aún
    if (!data.session) {
      throw new Error(
        'Cuenta creada. Si tu proyecto pide confirmar el correo, revisa la bandeja (o desactiva “Confirm email” en Supabase).',
      )
    }

    const { error: upsertError } = await supabase.from('profiles').upsert({
      id: data.user.id,
      email: clean,
      display_name: name,
      avatar_hue: Math.floor(Math.random() * 360),
    })
    if (upsertError) throw new Error(mapAuthError(upsertError.message))

    rememberEmail(clean, remember)
    return fetchProfile(data.user.id, clean)
  }

  if (password.length < 4) throw new Error('La contraseña debe tener al menos 4 caracteres')
  const existing = await findUserByLogin(clean)
  if (existing) throw new Error('Ya hay una cuenta con ese correo')

  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = bytesToHex(saltBytes)
  const passwordHash = await deriveKey(password, salt)
  const localPart = clean.split('@')[0]!

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
  persistLocalSession(user, remember)
  return user
}

export async function loginUser(
  email: string,
  password: string,
  remember = true,
): Promise<User> {
  const clean = normalizeEmail(email)

  if (isCloudAuthEnabled()) {
    const supabase = getSupabase()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: clean,
      password,
    })
    if (error) throw new Error(mapAuthError(error.message))
    if (!data.user) throw new Error('Correo o contraseña incorrectos')
    rememberEmail(clean, remember)
    return fetchProfile(data.user.id, data.user.email || clean)
  }

  const user = await findUserByLogin(clean)
  if (!user) throw new Error('Correo o contraseña incorrectos')

  const hash = await deriveKey(password, user.salt)
  if (hash !== user.passwordHash) throw new Error('Correo o contraseña incorrectos')

  if (!user.email) {
    const emailValue = clean.includes('@') ? clean : `${user.username}@local.myvibe`
    await db.users.update(user.id, { email: emailValue })
    user.email = emailValue
  }

  persistLocalSession(user, remember)
  return user
}

export async function requestPasswordReset(email: string): Promise<void> {
  if (!isCloudAuthEnabled()) {
    throw new Error('La recuperación de contraseña solo está disponible con cuentas en la nube')
  }
  const clean = normalizeEmail(email)
  if (!validateEmail(clean)) throw new Error('Introduce un correo válido')
  const supabase = getSupabase()
  const redirectTo = `${window.location.origin}/`
  const { error } = await supabase.auth.resetPasswordForEmail(clean, { redirectTo })
  if (error) throw new Error(mapAuthError(error.message))
}

export async function logoutUser(): Promise<void> {
  if (isCloudAuthEnabled()) {
    try {
      await getSupabase().auth.signOut()
    } catch {
      // ignore
    }
  }
  localStorage.removeItem(SESSION_KEY)
}

export function getRememberedEmail(): string {
  return localStorage.getItem(REMEMBER_EMAIL_KEY) ?? ''
}

export async function getSessionUser(): Promise<User | null> {
  if (isCloudAuthEnabled()) {
    const supabase = getSupabase()
    const { data } = await supabase.auth.getSession()
    const session = data.session
    if (!session?.user) return null
    try {
      return await fetchProfile(session.user.id, session.user.email || undefined)
    } catch {
      return null
    }
  }

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
  if (isCloudAuthEnabled()) {
    const supabase = getSupabase()
    const row: Record<string, unknown> = {}
    if (patch.displayName !== undefined) row.display_name = patch.displayName
    if (patch.bio !== undefined) row.bio = patch.bio
    if (patch.avatarHue !== undefined) row.avatar_hue = patch.avatarHue
    if (patch.email !== undefined) row.email = patch.email
    const { error } = await supabase.from('profiles').update(row).eq('id', userId)
    if (error) throw new Error(mapAuthError(error.message))
    return
  }
  await db.users.update(userId, patch)
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
  const blob = await normalizeAvatarBlob(file)
  const id = avatarCoverId(userId)
  const avatarUpdatedAt = Date.now()

  if (isCloudAuthEnabled()) {
    const supabase = getSupabase()
    const path = avatarStoragePath(userId)
    const { error: upError } = await supabase.storage
      .from('avatars')
      .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })
    if (upError) throw new Error(upError.message || 'No se pudo subir el avatar')

    const { error } = await supabase
      .from('profiles')
      .update({ has_avatar: true, avatar_updated_at: avatarUpdatedAt })
      .eq('id', userId)
    if (error) throw new Error(mapAuthError(error.message))

    revokeCachedUrls(id)
    await saveCoverBlob(id, blob)
    return fetchProfile(userId)
  }

  const user = await db.users.get(userId)
  if (!user) throw new Error('Sesión no válida')
  revokeCachedUrls(id)
  await saveCoverBlob(id, blob)
  await db.users.update(userId, { hasAvatar: true, avatarUpdatedAt })
  const updated = await db.users.get(userId)
  if (!updated) throw new Error('No se pudo guardar el avatar')
  return updated
}

export async function clearUserAvatar(userId: string): Promise<User> {
  const { revokeCachedUrls } = await import('./library')
  const { deleteBinary } = await import('./opfs')
  const id = avatarCoverId(userId)
  const avatarUpdatedAt = Date.now()

  if (isCloudAuthEnabled()) {
    const supabase = getSupabase()
    await supabase.storage.from('avatars').remove([avatarStoragePath(userId)])
    const { error } = await supabase
      .from('profiles')
      .update({ has_avatar: false, avatar_updated_at: avatarUpdatedAt })
      .eq('id', userId)
    if (error) throw new Error(mapAuthError(error.message))
    revokeCachedUrls(id)
    await deleteBinary('covers', id)
    await db.covers.delete(id)
    return fetchProfile(userId)
  }

  const user = await db.users.get(userId)
  if (!user) throw new Error('Sesión no válida')
  revokeCachedUrls(id)
  await deleteBinary('covers', id)
  await db.covers.delete(id)
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

  if (isCloudAuthEnabled()) {
    const supabase = getSupabase()
    const { error } = await supabase.auth.updateUser({ email: clean })
    if (error) throw new Error(mapAuthError(error.message))
    await updateProfile(userId, { email: clean })
    const remembered = localStorage.getItem(REMEMBER_EMAIL_KEY)
    if (remembered) localStorage.setItem(REMEMBER_EMAIL_KEY, clean)
    return fetchProfile(userId, clean)
  }

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
  if (remembered) localStorage.setItem(REMEMBER_EMAIL_KEY, clean)

  const updated = await db.users.get(userId)
  if (!updated) throw new Error('No se pudo guardar el correo')
  return updated
}

export async function changePassword(userId: string, newPassword: string): Promise<void> {
  if (isCloudAuthEnabled()) {
    if (newPassword.length < 6) {
      throw new Error('La nueva contraseña debe tener al menos 6 caracteres')
    }
    const { error } = await getSupabase().auth.updateUser({ password: newPassword })
    if (error) throw new Error(mapAuthError(error.message))
    return
  }

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
  if (isCloudAuthEnabled()) return 0
  return db.users.count()
}
