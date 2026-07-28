import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export function isCloudAuthEnabled(): boolean {
  return Boolean(url?.trim() && anon?.trim())
}

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!isCloudAuthEnabled()) {
    throw new Error(
      'Falta configurar Supabase. Crea un proyecto gratis en supabase.com y añade VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.',
    )
  }
  if (!client) {
    client = createClient(url!.trim(), anon!.trim(), {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  }
  return client
}
