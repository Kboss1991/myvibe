/**
 * Sync de podcasts seguidos + progreso de episodios (cuenta Supabase).
 * El audio de los episodios se sigue reproduciendo por URL (no se sube a la nube).
 */
import { getSupabase, isCloudAuthEnabled } from './supabase'
import {
  applyPodcastProgressFromCloud,
  getAllPodcastProgress,
  getMyPodcasts,
  replaceMyPodcastsFromCloud,
  type PodcastProgress,
  type PodcastShow,
} from './podcasts'

const PODCAST_SQL_HINT =
  'Faltan las tablas podcast_subscriptions / podcast_progress. En Supabase → SQL Editor ejecuta supabase/podcast-sync.sql'

export { PODCAST_SQL_HINT }

type CloudSubRow = {
  show_id: string
  name: string
  artist: string
  feed_url: string
  artwork_url: string
  genre: string
  updated_at: string
}

type CloudProgressRow = {
  episode_id: string
  show_id: string
  position: number
  duration: number
  completed: boolean
  updated_at: string
}

function isMissingTable(msg: string): boolean {
  return /relation|does not exist|schema cache|podcast_subscriptions|podcast_progress/i.test(
    msg,
  )
}

export async function checkPodcastTablesReady(): Promise<boolean> {
  if (!isCloudAuthEnabled()) return false
  const supabase = getSupabase()
  const [a, b] = await Promise.all([
    supabase.from('podcast_subscriptions').select('show_id').limit(1),
    supabase.from('podcast_progress').select('episode_id').limit(1),
  ])
  if (a.error && isMissingTable(a.error.message)) return false
  if (b.error && isMissingTable(b.error.message)) return false
  return true
}

export async function pushPodcastSubscriptions(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const shows = getMyPodcasts()
  const nowIso = new Date().toISOString()
  const rows = shows.map((s) => ({
    user_id: userId,
    show_id: s.id,
    name: s.name || '',
    artist: s.artist || '',
    feed_url: s.feedUrl || '',
    artwork_url: s.artworkUrl || '',
    genre: s.genre || '',
    updated_at: nowIso,
  }))

  const { data: remote, error: listErr } = await supabase
    .from('podcast_subscriptions')
    .select('show_id')
    .eq('user_id', userId)
  if (listErr) {
    if (isMissingTable(listErr.message)) throw new Error(PODCAST_SQL_HINT)
    throw new Error(listErr.message)
  }

  if (rows.length) {
    const { error } = await supabase.from('podcast_subscriptions').upsert(rows, {
      onConflict: 'user_id,show_id',
    })
    if (error) {
      if (isMissingTable(error.message)) throw new Error(PODCAST_SQL_HINT)
      throw new Error(error.message)
    }
  }

  const keep = new Set(shows.map((s) => s.id))
  const toDelete = ((remote || []) as { show_id: string }[])
    .map((r) => r.show_id)
    .filter((id) => !keep.has(id))
  if (toDelete.length) {
    const { error } = await supabase
      .from('podcast_subscriptions')
      .delete()
      .eq('user_id', userId)
      .in('show_id', toDelete)
    if (error && !isMissingTable(error.message)) {
      console.warn('podcast sub delete', error.message)
    }
  }
  return rows.length
}

export async function pullPodcastSubscriptions(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('podcast_subscriptions')
    .select('show_id,name,artist,feed_url,artwork_url,genre,updated_at')
    .eq('user_id', userId)
  if (error) {
    if (isMissingTable(error.message)) throw new Error(PODCAST_SQL_HINT)
    throw new Error(error.message)
  }
  const rows = (data || []) as CloudSubRow[]
  const shows: PodcastShow[] = rows
    .map((r) => ({
      id: r.show_id,
      name: r.name || 'Podcast',
      artist: r.artist || '',
      feedUrl: r.feed_url || '',
      artworkUrl: r.artwork_url || '',
      genre: r.genre || undefined,
    }))
    .filter((s) => s.id && s.feedUrl)
  replaceMyPodcastsFromCloud(shows)
  return shows.length
}

export async function pushPodcastProgress(
  userId: string,
  episodeId?: string,
): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const all = getAllPodcastProgress()
  const entries = episodeId
    ? all.filter((e) => e.episodeId === episodeId)
    : all
  if (!entries.length) return 0

  const remoteById = new Map<string, number>()
  const ids = entries.map((e) => e.episodeId)
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80)
    const { data, error } = await supabase
      .from('podcast_progress')
      .select('episode_id,updated_at')
      .eq('user_id', userId)
      .in('episode_id', slice)
    if (error) {
      if (isMissingTable(error.message)) throw new Error(PODCAST_SQL_HINT)
      console.warn('podcast progress remote check', error.message)
      break
    }
    for (const row of (data || []) as { episode_id: string; updated_at: string }[]) {
      remoteById.set(row.episode_id, Date.parse(row.updated_at) || 0)
    }
  }

  const rows = entries
    .filter((e) => e.progress.updatedAt >= (remoteById.get(e.episodeId) ?? 0))
    .map((e) => ({
      user_id: userId,
      episode_id: e.episodeId,
      show_id: e.showId || '',
      position: e.progress.position || 0,
      duration: e.progress.duration || 0,
      completed: Boolean(e.progress.completed),
      updated_at: new Date(e.progress.updatedAt || Date.now()).toISOString(),
    }))

  if (!rows.length) return 0

  for (let i = 0; i < rows.length; i += 80) {
    const slice = rows.slice(i, i + 80)
    const { error } = await supabase.from('podcast_progress').upsert(slice, {
      onConflict: 'user_id,episode_id',
    })
    if (error) {
      if (isMissingTable(error.message)) throw new Error(PODCAST_SQL_HINT)
      throw new Error(error.message)
    }
  }
  return rows.length
}

export async function pullPodcastProgress(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('podcast_progress')
    .select('episode_id,show_id,position,duration,completed,updated_at')
    .eq('user_id', userId)
  if (error) {
    if (isMissingTable(error.message)) throw new Error(PODCAST_SQL_HINT)
    throw new Error(error.message)
  }
  const rows = (data || []) as CloudProgressRow[]
  let applied = 0
  for (const r of rows) {
    const remote: PodcastProgress = {
      position: Number(r.position) || 0,
      duration: Number(r.duration) || 0,
      completed: Boolean(r.completed),
      updatedAt: Date.parse(r.updated_at) || 0,
      showId: r.show_id || undefined,
    }
    if (applyPodcastProgressFromCloud(r.episode_id, remote)) applied += 1
  }
  return applied
}

export async function syncPodcastTaste(userId: string): Promise<{
  subsIn: number
  subsOut: number
  progressIn: number
  progressOut: number
}> {
  const subsIn = await pullPodcastSubscriptions(userId)
  const progressIn = await pullPodcastProgress(userId)
  const subsOut = await pushPodcastSubscriptions(userId)
  const progressOut = await pushPodcastProgress(userId)
  return { subsIn, subsOut, progressIn, progressOut }
}

export async function pullPodcastTaste(userId: string): Promise<void> {
  await pullPodcastSubscriptions(userId)
  await pullPodcastProgress(userId)
}

export function subscribePodcastTaste(
  userId: string,
  onRemoteChange: () => void,
): () => void {
  if (!isCloudAuthEnabled()) return () => undefined
  const supabase = getSupabase()
  let timer: number | null = null
  const notify = () => {
    if (timer != null) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      onRemoteChange()
    }, 250)
  }
  const channel = supabase
    .channel(`podcast-taste:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'podcast_subscriptions',
        filter: `user_id=eq.${userId}`,
      },
      notify,
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'podcast_progress',
        filter: `user_id=eq.${userId}`,
      },
      notify,
    )
    .subscribe()
  return () => {
    if (timer != null) window.clearTimeout(timer)
    void supabase.removeChannel(channel)
  }
}
