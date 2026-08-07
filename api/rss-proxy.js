/**
 * Proxy RSS para evitar CORS en el cliente.
 * Decodifica charset del Content-Type / declaración XML (p. ej. ISO-8859-1 de 3Cat).
 * GET /api/rss-proxy?url=<encoded feed url>
 */

function charsetFromContentType(ct) {
  if (!ct) return null
  const m = /charset\s*=\s*["']?([^"';\s]+)/i.exec(ct)
  return m ? m[1].trim().toLowerCase() : null
}

function charsetFromXmlDeclaration(buf) {
  const head = Buffer.from(buf.subarray(0, Math.min(buf.byteLength, 256))).toString('ascii')
  const m = /encoding\s*=\s*["']\s*([^"']+)\s*["']/i.exec(head)
  return m ? m[1].trim().toLowerCase() : null
}

function normalizeCharset(raw) {
  if (!raw) return 'utf-8'
  const c = raw.toLowerCase().replace(/_/g, '-')
  if (c === 'utf8') return 'utf-8'
  if (
    c === 'iso-8859-1' ||
    c === 'latin1' ||
    c === 'latin-1' ||
    c === 'iso8859-1'
  ) {
    return 'iso-8859-1'
  }
  if (c === 'windows-1252' || c === 'cp1252' || c === 'win-1252') {
    return 'windows-1252'
  }
  return c
}

function decodeXmlBuffer(buf, contentType) {
  const label = normalizeCharset(
    charsetFromContentType(contentType) || charsetFromXmlDeclaration(buf) || 'utf-8',
  )
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    try {
      return new TextDecoder('utf-8').decode(buf)
    } catch {
      return Buffer.from(buf).toString('utf8')
    }
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const raw = typeof req.query.url === 'string' ? req.query.url : ''
  let target
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return res.status(400).json({ error: 'Invalid URL' })
    }
    target = u.toString()
  } catch {
    return res.status(400).json({ error: 'Invalid URL' })
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': 'MyVibePodcast/1.0',
      },
      redirect: 'follow',
    })
    const buf = new Uint8Array(await upstream.arrayBuffer())
    const ct = upstream.headers.get('content-type') || ''
    const text = decodeXmlBuffer(buf, ct)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', 'application/xml; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=300')
    return res.status(upstream.ok ? 200 : upstream.status).send(text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Fetch failed'
    return res.status(502).json({ error: msg })
  }
}
