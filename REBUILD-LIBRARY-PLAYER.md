# Motor de biblioteca nuevo (v1)

`src/store/libraryPlayerStore.ts` — escrito desde cero:

- Su propio `<audio>` (no usa `audioEngine` ni `loadAndMaybePlay`)
- Media Session mínima (metadata + play/pause/next/prev + `playbackState`)
- **Sin** `setPositionState` en cada tick (causa del Play fantasma en iOS)
- **Sin** holds / reclaim / CarPlay labyrinth del `playerStore` viejo

`playerStore` solo gestiona radio y podcasts. La biblioteca ya no pasa por él.

Archivo histórico: `archive/full-library-player`.
