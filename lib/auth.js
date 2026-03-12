const crypto = require('crypto');

const SECRET = process.env.AUTH_PASSWORD || '';

function makeToken() {
  const ts = Date.now().toString();
  const hmac = crypto.createHmac('sha256', SECRET).update(ts).digest('hex');
  return `${ts}.${hmac}`;
}

function verifyToken(token) {
  if (!token) return false;
  const [ts, hmac] = token.split('.');
  if (!ts || !hmac) return false;
  const expected = crypto.createHmac('sha256', SECRET).update(ts).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
}

function authMiddleware(req, res, next) {
  // If no password set, skip auth
  if (!SECRET) return next();

  const token = req.cookies?.auth_token;
  if (token && verifyToken(token)) return next();

  return res.status(401).json({ error: 'Unauthorized' });
}

function loginHandler(req, res) {
  if (!SECRET) {
    return res.json({ ok: true, token: 'none' });
  }

  const { password } = req.body;
  if (password !== SECRET) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = makeToken();
  res.cookie('auth_token', token, {
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax'
  });
  res.json({ ok: true });
}

module.exports = { authMiddleware, loginHandler };
