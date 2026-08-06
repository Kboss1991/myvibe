/* global self, caches, Response, Headers */
/**
 * Service Worker helper: sirve /local-audio/* con Accept-Ranges y 206 Partial Content.
 * iOS Safari necesita Range al pausar/reanudar audio local en PWA.
 *
 * Cargado vía workbox.importScripts desde vite.config.ts.
 */
;(function () {
  var CACHE = 'myvibe-local-audio-v1'
  var PREFIX = '/local-audio/'

  function parseRange(header, size) {
    if (!header || typeof header !== 'string') return null
    var m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
    if (!m) return null
    var start = m[1] === '' ? null : parseInt(m[1], 10)
    var end = m[2] === '' ? null : parseInt(m[2], 10)
    if (start === null && end === null) return null
    if (start === null) {
      // bytes=-N → últimos N bytes
      var suffix = end
      if (!Number.isFinite(suffix) || suffix <= 0) return null
      start = Math.max(0, size - suffix)
      end = size - 1
    } else {
      if (!Number.isFinite(start) || start < 0 || start >= size) return null
      if (end === null || !Number.isFinite(end) || end >= size) end = size - 1
      if (end < start) return null
    }
    return { start: start, end: end }
  }

  async function matchCached(cache, pathname, requestUrl) {
    return (
      (await cache.match(requestUrl)) ||
      (await cache.match(pathname)) ||
      (await cache.match(new Request(requestUrl))) ||
      null
    )
  }

  async function serveLocalAudio(request) {
    var url = new URL(request.url)
    if (!url.pathname.startsWith(PREFIX)) {
      return fetch(request)
    }

    var cache = await caches.open(CACHE)
    var cached = await matchCached(cache, url.pathname, url.href)
    if (!cached) {
      return new Response('Audio not cached', { status: 404, statusText: 'Not Found' })
    }

    var blob = await cached.blob()
    var size = blob.size
    var type =
      cached.headers.get('Content-Type') || blob.type || 'audio/mpeg'
    var rangeHeader = request.headers.get('Range') || request.headers.get('range')

    if (!rangeHeader) {
      return new Response(blob, {
        status: 200,
        headers: {
          'Content-Type': type,
          'Content-Length': String(size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }

    var range = parseRange(rangeHeader, size)
    if (!range) {
      return new Response('Malformed Range', {
        status: 416,
        headers: {
          'Content-Range': 'bytes */' + size,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    var slice = blob.slice(range.start, range.end + 1, type)
    var sliceSize = range.end - range.start + 1
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(sliceSize),
        'Content-Range':
          'bytes ' + range.start + '-' + range.end + '/' + size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  }

  self.addEventListener('fetch', function (event) {
    try {
      var url = new URL(event.request.url)
      if (!url.pathname.startsWith(PREFIX)) return
      event.respondWith(serveLocalAudio(event.request))
    } catch (_) {
      /* ignore */
    }
  })
})()
