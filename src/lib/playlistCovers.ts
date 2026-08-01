import { getSupabase, isCloudAuthEnabled } from './supabase'
import {
  getCoverBlob,
  playlistCoverId,
  revokeCachedUrls,
  saveCoverBlob,
} from './library'

/** Reutiliza el bucket `avatars` (ya existe): {userId}/playlist-{id}.jpg */
export function playlistCoverStoragePath(userId: string, playlistId: string): string {
  const safe = playlistId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `${userId}/playlist-${safe}.jpg`
}

export async function uploadPlaylistCoverCloud(
  userId: string,
  playlistId: string,
): Promise<boolean> {
  if (!isCloudAuthEnabled()) return false
  const blob = await getCoverBlob(playlistCoverId(playlistId))
  if (!blob) return false
  const supabase = getSupabase()
  const path = playlistCoverStoragePath(userId, playlistId)
  const { error } = await supabase.storage.from('avatars').upload(path, blob, {
    upsert: true,
    contentType: blob.type || 'image/jpeg',
  })
  if (error) {
    console.warn('Upload playlist cover', error.message)
    return false
  }
  return true
}

export async function downloadPlaylistCoverCloud(
  userId: string,
  playlistId: string,
): Promise<boolean> {
  if (!isCloudAuthEnabled()) return false
  const supabase = getSupabase()
  const path = playlistCoverStoragePath(userId, playlistId)
  const { data, error } = await supabase.storage.from('avatars').download(path)
  if (error || !data) return false
  const id = playlistCoverId(playlistId)
  revokeCachedUrls(id)
  await saveCoverBlob(id, data)
  return true
}

export async function removePlaylistCoverCloud(
  userId: string,
  playlistId: string,
): Promise<void> {
  if (!isCloudAuthEnabled()) return
  try {
    await getSupabase()
      .storage.from('avatars')
      .remove([playlistCoverStoragePath(userId, playlistId)])
  } catch {
    // ignore
  }
}
