import { create } from 'zustand'
import * as auth from '../lib/auth'
import type { User } from '../types'

interface AuthState {
  user: User | null
  ready: boolean
  error: string | null
  rememberedEmail: string
  hydrate: () => Promise<void>
  login: (email: string, password: string, remember?: boolean) => Promise<void>
  register: (
    email: string,
    password: string,
    displayName: string,
    remember?: boolean,
  ) => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
  logout: () => void
  updateProfile: (patch: Partial<Pick<User, 'displayName' | 'bio' | 'avatarHue'>>) => Promise<void>
  setEmail: (email: string) => Promise<void>
  setAvatar: (file: File) => Promise<void>
  clearAvatar: () => Promise<void>
  changePassword: (newPassword: string) => Promise<void>
  exportAccount: () => Promise<'downloaded'>
  importAccount: (file: File) => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  ready: false,
  error: null,
  rememberedEmail: '',

  hydrate: async () => {
    const rememberedEmail = auth.getRememberedEmail()
    const user = await auth.getSessionUser()
    set({ user, ready: true, rememberedEmail })
  },

  login: async (email, password, remember = true) => {
    set({ error: null })
    try {
      const user = await auth.loginUser(email, password, remember)
      set({ user, rememberedEmail: remember ? user.email : get().rememberedEmail })
    } catch (e) {
      const msg =
        e instanceof Error && e.message
          ? e.message
          : 'Error al iniciar sesión. Si estás en el móvil, regístrate (la cuenta del PC no está aquí).'
      set({ error: msg })
      throw e
    }
  },

  register: async (email, password, displayName, remember = true) => {
    set({ error: null })
    try {
      const user = await auth.registerUser(email, password, displayName, remember)
      set({ user, rememberedEmail: remember ? user.email : '' })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Error al registrarse' })
      throw e
    }
  },

  requestPasswordReset: async (email) => {
    set({ error: null })
    try {
      await auth.requestPasswordReset(email)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'No se pudo enviar el correo' })
      throw e
    }
  },

  logout: () => {
    void auth.logoutUser()
    set({ user: null })
  },

  updateProfile: async (patch) => {
    const user = get().user
    if (!user) return
    set({ error: null })
    try {
      await auth.updateProfile(user.id, patch)
      set({ user: { ...user, ...patch } })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'No se pudo guardar el perfil' })
      throw e
    }
  },

  setEmail: async (email) => {
    const user = get().user
    if (!user) return
    set({ error: null })
    try {
      const updated = await auth.setUserEmail(user.id, email)
      set({
        user: updated,
        rememberedEmail: auth.getRememberedEmail() || updated.email,
      })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'No se pudo guardar el correo' })
      throw e
    }
  },

  setAvatar: async (file) => {
    const user = get().user
    if (!user) return
    set({ error: null })
    try {
      const updated = await auth.setUserAvatar(user.id, file)
      set({ user: updated })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'No se pudo guardar el avatar' })
      throw e
    }
  },

  clearAvatar: async () => {
    const user = get().user
    if (!user) return
    set({ error: null })
    try {
      const updated = await auth.clearUserAvatar(user.id)
      set({ user: updated })
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'No se pudo quitar el avatar' })
      throw e
    }
  },

  changePassword: async (newPassword) => {
    const user = get().user
    if (!user) return
    set({ error: null })
    try {
      await auth.changePassword(user.id, newPassword)
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'No se pudo cambiar la contraseña' })
      throw e
    }
  },

  exportAccount: async () => {
    const user = get().user
    if (!user) throw new Error('No hay sesión')
    const { downloadAccountZip } = await import('../lib/accountTransfer')
    return downloadAccountZip(user.id)
  },

  importAccount: async (file) => {
    set({ error: null })
    try {
      if (auth.isCloudAuthEnabled()) {
        throw new Error(
          'Con cuentas en la nube no hace falta importar: inicia sesión con el mismo correo en cualquier dispositivo.',
        )
      }
      const { importAccountTransfer } = await import('../lib/accountTransfer')
      const user = await importAccountTransfer(file)
      set({
        user,
        rememberedEmail: user.email,
        ready: true,
      })
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : 'No se pudo importar la cuenta',
      })
      throw e
    }
  },

  clearError: () => set({ error: null }),
}))
