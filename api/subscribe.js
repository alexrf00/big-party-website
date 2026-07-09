// Wishlist signup -> Brevo contact list.
// Vercel serverless function. BREVO_API_KEY is read server-side only and is
// never exposed to the browser. The client only receives { ok: true|false }.
//
// Abuse protection (no external infra required):
//   - hidden honeypot field: naive bots fill it -> silently dropped;
//   - per-IP rate limit: caps bursts from a single client.
//
// NOTE ON THE RATE LIMIT: it's an in-memory, per-instance counter, so it's a
// soft guard. Under normal (low) traffic Vercel keeps one warm instance and it
// works well; under heavy scale each instance counts separately, so it won't
// enforce a hard global limit. For strong, distributed limits, back it with a
// shared store (Upstash Redis / Vercel KV) -- easy to swap in later.

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_HITS = 5; // requests per IP per window
const hits = new Map(); // ip -> [timestamps]

function tooMany(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // bound memory: occasionally evict IPs with no recent activity
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > MAX_HITS;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'not_configured' });

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    'unknown';

  if (tooMany(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Honeypot: real users never see or fill this. Pretend success so bots don't
  // learn they were caught, but never touch Brevo.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return res.status(200).json({ ok: true });
  }

  const email = (body.email || '').toString().trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ ok: false, error: 'invalid_email' });
  }

  const listId = Number(process.env.BREVO_LIST_ID || 2);

  try {
    const r = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ email, listIds: [listId], updateEnabled: true }),
    });

    // 201 = created, 204 = existing contact updated (both success).
    if (r.status === 201 || r.status === 204) return res.status(200).json({ ok: true });

    const data = await r.json().catch(() => ({}));
    // Already on the list -> idempotent success.
    if (r.status === 400 && (data.code === 'duplicate_parameter' || /already/i.test(data.message || ''))) {
      return res.status(200).json({ ok: true, already: true });
    }
    return res.status(502).json({ ok: false, error: 'provider_error' });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'network_error' });
  }
};
