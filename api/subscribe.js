// Wishlist signup -> Brevo contact list.
// Runs as a Vercel serverless function. The Brevo API key is read from the
// BREVO_API_KEY environment variable (server-side only) and is NEVER sent to
// the browser. The client only receives { ok: true } / { ok: false }.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'not_configured' });

  // Vercel parses JSON bodies automatically, but be defensive.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const email = ((body && body.email) || '').toString().trim().toLowerCase();
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

    // 201 = created, 204 = existing contact updated (both are success).
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
