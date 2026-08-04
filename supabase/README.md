# Cuentas en la nube (gratis) con Supabase

1. Entra en https://supabase.com y crea un proyecto (Free).
2. Project Settings → API:
   - Project URL → VITE_SUPABASE_URL
   - anon public → VITE_SUPABASE_ANON_KEY
3. SQL Editor → pega y ejecuta `schema.sql` de esta carpeta.
4. Authentication → Providers → Email → desactiva **Confirm email**.
5. Local: copia `.env.example` a `.env.local` con esas claves.
6. Vercel: Project → Settings → Environment Variables → las mismas dos vars → Redeploy.

La música NO se sube a Supabase (sigue en cada dispositivo). Sí se sincronizan:
- usuarios / perfil / avatar
- catálogo de canciones (metadatos)
- **me gusta** y **playlists** (datos de perfil PC ↔ móvil)

Tras crear el proyecto, ejecuta también `library.sql` (catálogo + likes + playlists).
Si ya tenías `library.sql` antiguo, vuelve a ejecutarlo: añade las tablas `library_likes` y `library_playlists`, la columna `audio_updated_at` / `audio_bytes`, publica `library_tracks` en Realtime (sync automática del catálogo) y activa Realtime para me gusta/playlists.

Me gusta y playlists se suben solos en cada acción; el otro dispositivo las recibe por Realtime o en unos segundos.

7. SQL Editor → ejecuta `profile-social.sql` (dispositivos, círculo cercano, presencia y playlists compartidas).
   Sin este script, el perfil muestra stats locales y sync, pero dispositivos/amigos fallarán en nube.
