/**
 * Proxy RSS para evitar CORS en el cliente.
 * GET /api/rss-proxy?url=<encoded feed url>
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
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'User-Agent': 'MyVibePodcast/1.0',
      },
      redirect: 'follow',
    })
    const text = await upstream.text()
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/xml; charset=utf-8',
    )
    res.setHeader('Cache-Control', 'public, max-age=300')
    return res.status(upstream.ok ? 200 : upstream.status).send(text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Fetch failed'
    return res.status(502).json({ error: msg })
  }
}
