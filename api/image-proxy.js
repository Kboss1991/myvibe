/**
 * Proxy de imágenes (portadas de podcast, etc.) para evitar CORS en el cliente.
 * GET /api/image-proxy?url=<encoded image url>
 */
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
        Accept: 'image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8',
        // UA de navegador: algunos CDN de podcasts rechazan bots
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Referer: 'https://www.apple.com/',
      },
      redirect: 'follow',
    })
    if (!upstream.ok) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      return res.status(upstream.status).json({ error: 'Upstream error' })
    }
    const buf = Buffer.from(await upstream.arrayBuffer())
    if (!buf.length) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      return res.status(502).json({ error: 'Empty image' })
    }
    let type = upstream.headers.get('content-type') || ''
    if (!/^image\//i.test(type)) {
      // Inferir por magic bytes si el CDN manda octet-stream
      if (buf[0] === 0xff && buf[1] === 0xd8) type = 'image/jpeg'
      else if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png'
      else if (buf[0] === 0x52 && buf[1] === 0x49) type = 'image/webp'
      else if (buf[0] === 0x47 && buf[1] === 0x49) type = 'image/gif'
      else {
        res.setHeader('Access-Control-Allow-Origin', '*')
        return res.status(415).json({ error: 'Not an image' })
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
    return res.status(200).send(buf)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Fetch failed'
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.status(502).json({ error: msg })
  }
}
