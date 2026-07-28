# MyVibe

PWA musical local tipo Spotify: sube tus canciones (descargadas o creadas con IA), organízalas y escúchalas en el coche vía Bluetooth del móvil. Sin anuncios ni nube.

## Cómo arrancar

```bash
npm install
npm run dev
```

Abre la URL en el móvil (misma red) o usa Chrome DevTools → device mode.

## Instalar en el móvil

1. Abre la app en Chrome (Android) o Safari (iOS).
2. **Añadir a pantalla de inicio**.
3. Empareja el teléfono con el coche por Bluetooth.
4. Reproduce: el audio sale por el coche; los botones del volante usan Media Session.

## Funciones

- Biblioteca local (OPFS / IndexedDB)
- Playlists, likes, cola, shuffle, repeat, seek
- Subida multi-archivo y carpeta
- Modo conducción
- Offline PWA

## Scripts

- `npm run dev` — desarrollo
- `npm run build` — producción
- `npm run preview` — previsualizar build
