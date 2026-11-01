const crypto = require('crypto');
const cfg = require('./config');
const { q } = require('./db');
const { HttpError } = require('./http');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${h}`;
}
function verifyPassword(password, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const hb = Buffer.from(h, 'hex');
  return hb.length === test.length && crypto.timingSafeEqual(hb, test);
}
const b64 = b => Buffer.from(b).toString('base64url');
function signToken(payload, ttlSec = 7 * 86400) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expect = crypto.createHmac('sha256', cfg.secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}
function userFromReq(req) {
  const h = req.headers.authorization || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!p) return null;
  const u = q.get('SELECT * FROM users WHERE id=?', p.uid);
  return u && !u.suspended ? u : null;
}
const requireAuth = (...roles) => (ctx) => {
  const u = userFromReq(ctx.req);
  if (!u) throw new HttpError(401, 'Please sign in');
  if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'You do not have access to this area');
  ctx.user = u;
};
function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, address: u.address || '' };
}
module.exports = { hashPassword, verifyPassword, signToken, verifyToken, userFromReq, requireAuth, publicUser };
