// Auth, account, meta, notifications, support.
const crypto = require('crypto');
const cfg = require('../config');
const { q, shopSettings } = require('../db');
const { HttpError, rateLimit } = require('../http');
const { hashPassword, verifyPassword, signToken, requireAuth, publicUser } = require('../auth');
const catalog = require('../catalog');
const { str, isEmail } = require('../util');

const publicShop = () => { const s = shopSettings(); return { name: s.shop_name, delivery_fee: s.delivery_fee, free_delivery_over: s.free_delivery_over, offers_pickup: !!s.offers_pickup, pickup_info: s.pickup_info, phone: s.phone, whatsapp: s.whatsapp, returns_policy: s.returns_policy, payments_enabled: !!cfg.paystackKey || cfg.demoPayments }; };

module.exports = (r) => {
  // ---- meta ----
  r.get('/api/meta', async ctx => {
    let categories = []; try { categories = catalog.categoriesOf(catalog.live((await catalog.ensure()).rows)); } catch {}
    return { shop: publicShop(), categories, payments: cfg.paystackKey ? 'paystack' : 'demo' };
  });
  r.get('/api/health', async ctx => { await q.get('SELECT 1'); return { ok: true, uptime_s: Math.round(process.uptime()), time: new Date().toISOString() }; });
  // Coloured initials tile shown when a product has no photo yet.
  r.get('/api/placeholder/:id', async ctx => {
    const id = parseInt(ctx.params.id, 10); let name = '?'; try { const p = (await catalog.ensure()).byId.get(id); if (p) name = p.name; } catch {}
    const hue = (id * 47) % 360, words = String(name).trim().split(/\s+/), ch = ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase().replace(/[<>&"']/g, '?');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 90%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 50% 80%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="200" cy="200" r="104" fill="hsl(${hue} 45% 98% / .55)"/><text x="200" y="238" font-family="sans-serif" font-size="104" font-weight="700" text-anchor="middle" fill="hsl(${hue} 40% 32%)">${ch}</text></svg>`;
    ctx.raw(200, svg, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
  });

  // ---- auth ----
  r.post('/api/auth/register', async ctx => {
    if (!rateLimit('reg:' + ctx.ip, 10, 3600e3)) throw new HttpError(429, 'Too many sign-ups from this network. Try again later.');
    const b = ctx.body;
    const email = str(b.email, 120, { required: true, name: 'Email' }).toLowerCase(), name = str(b.name, 80, { required: true, name: 'Name' });
    if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
    if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (await q.get('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with this email already exists');
    const res = await q.run("INSERT INTO users(role,name,email,phone,password_hash,address) VALUES('customer',?,?,?,?,?)", name, email, str(b.phone, 30) || null, hashPassword(String(b.password)), str(b.address, 250) || null);
    const u = await q.get('SELECT * FROM users WHERE id=?', Number(res.lastInsertRowid));
    return { token: signToken({ uid: u.id, role: u.role }), user: publicUser(u) };
  });
  r.post('/api/auth/login', async ctx => {
    const email = str(ctx.body.email, 120).toLowerCase();
    if (!rateLimit('login:' + ctx.ip + email, 8, 15 * 60e3)) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
    const u = await q.get('SELECT * FROM users WHERE email=?', email);
    if (!u || !verifyPassword(String(ctx.body.password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect email or password');
    if (u.suspended) throw new HttpError(403, 'This account has been suspended. Contact support.');
    // Separate portals: admins sign in at /admin-login.html, buyers at /login.html.
    const portal = ctx.body.portal === 'admin' ? 'admin' : 'buyer';
    if (portal === 'admin' && u.role !== 'admin') throw new HttpError(403, 'This account does not have admin access. Buyers can sign in at /login.html.');
    if (portal === 'buyer' && u.role === 'admin') throw new HttpError(403, 'Admin accounts sign in at /admin-login.html.');
    return { token: signToken({ uid: u.id, role: u.role }), user: publicUser(u) };
  });
  r.post('/api/auth/forgot', async ctx => {
    if (!rateLimit('forgot:' + ctx.ip, 5, 3600e3)) throw new HttpError(429, 'Too many requests');
    const u = await q.get('SELECT * FROM users WHERE email=?', str(ctx.body.email, 120).toLowerCase());
    const out = { ok: true, message: 'If that email exists, a reset link has been sent.' };
    if (u) {
      const token = crypto.randomBytes(24).toString('hex');
      await q.run('UPDATE users SET reset_token=?, reset_expires=? WHERE id=?', crypto.createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600e3).toISOString(), u.id);
      require('../mail').send(u.email, `Reset your ${shopSettings().shop_name} password`, `Use this link within one hour to choose a new password:\n${cfg.publicUrl}/${u.role === 'admin' ? 'admin-login' : 'login'}.html?reset=${token}\n\nIf you did not ask for this, ignore this email.`);
      if (process.env.NODE_ENV !== 'production') out.dev_reset_token = token;
    }
    return out;
  });
  r.post('/api/auth/reset', async ctx => {
    const token = str(ctx.body.token, 100), pw = String(ctx.body.password || '');
    if (pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    const u = await q.get('SELECT * FROM users WHERE reset_token=?', crypto.createHash('sha256').update(token).digest('hex'));
    if (!u || new Date(u.reset_expires) < new Date()) throw new HttpError(400, 'This reset link is invalid or has expired');
    await q.run('UPDATE users SET password_hash=?, reset_token=NULL, reset_expires=NULL WHERE id=?', hashPassword(pw), u.id);
    return { ok: true };
  });
  r.get('/api/me', requireAuth(), async ctx => ({ user: publicUser(ctx.user), unread: (await q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0', ctx.user.id)).c }));
  r.patch('/api/me', requireAuth(), async ctx => {
    const b = ctx.body, u = ctx.user;
    await q.run('UPDATE users SET name=?, phone=?, address=? WHERE id=?', str(b.name, 80) || u.name, b.phone !== undefined ? (str(b.phone, 30) || null) : u.phone, b.address !== undefined ? (str(b.address, 250) || null) : u.address, u.id);
    if (b.new_password) {
      if (!verifyPassword(String(b.current_password || ''), u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
      if (String(b.new_password).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
      await q.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(String(b.new_password)), u.id);
    }
    return { user: publicUser(await q.get('SELECT * FROM users WHERE id=?', u.id)) };
  });
  // Deleting an account removes the profile and reviews. Past orders are kept for our accounting records but detached from the account.
  r.delete('/api/me', requireAuth('customer'), async ctx => {
    await q.tx(async () => { const id = ctx.user.id; await q.run('DELETE FROM reviews WHERE user_id=?', id); await q.run('UPDATE orders SET customer_id=NULL WHERE customer_id=?', id); await q.run('DELETE FROM users WHERE id=?', id); });
    return { ok: true };
  });
  r.get('/api/notifications', requireAuth(), async ctx => await q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', ctx.user.id));
  r.post('/api/notifications/read', requireAuth(), async ctx => { await q.run('UPDATE notifications SET is_read=1 WHERE user_id=?', ctx.user.id); return { ok: true }; });
  r.post('/api/support', requireAuth(), async ctx => {
    await q.run('INSERT INTO support_requests(user_id,subject,message) VALUES(?,?,?)', ctx.user.id, str(ctx.body.subject, 120, { required: true, name: 'Subject' }), str(ctx.body.message, 2000, { required: true, name: 'Message' }));
    return { ok: true };
  });
};
module.exports.publicShop = publicShop;
