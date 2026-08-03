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
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'MyVibePodcast/1.0',
      },
      redirect: 'follow',
    })
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Upstream error' })
    }
    const buf = Buffer.from(await upstream.arrayBuffer())
    if (!buf.length) {
      return res.status(502).json({ error: 'Empty image' })
    }
    const type = upstream.headers.get('content-type') || 'image/jpeg'
    if (!/^image\//i.test(type) && !/octet-stream/i.test(type)) {
      return res.status(415).json({ error: 'Not an image' })
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', type.startsWith('image/') ? type : 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.status(200).send(buf)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Fetch failed'
    return res.status(502).json({ error: msg })
  }
}
