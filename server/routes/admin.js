// Admin: products (stored in Supabase), photo uploads, orders, customers, discount codes, settings, support.
const crypto = require('crypto');
const os = require('os');
const cfg = require('../config');
const { q, getSetting, setSetting, audit, notify, shopSettings, SHOP_DEFAULTS } = require('../db');
const { HttpError } = require('../http');
const { requireAuth } = require('../auth');
const { str, num, bool, list } = require('../util');
const catalog = require('../catalog');
const supa = require('../supa');
const mail = require('../mail');
const { ps } = require('../paystack');
const { summary, money } = require('./shop');
const admin = requireAuth('admin');

const PAID = catalog.PAID;
function productData(b, existing) {
  const d = {};
  const has = k => b[k] !== undefined;
  if (has('name') || !existing) d.name = str(b.name, 200, { required: true, name: 'Name' });
  if (has('description') || !existing) d.description = str(b.description, 4000) || null;
  if (has('category') || !existing) d.category = str(b.category, 60) || null;
  if (has('price') || !existing) d.price = num(b.price, { min: 0, max: 1e9, name: 'Price', required: true });
  if (has('compare_at') || !existing) d.compare_at = num(b.compare_at, { min: 0, max: 1e9, name: 'Old price' });
  const price = d.price !== undefined ? d.price : existing.price;
  if (d.compare_at != null && !(d.compare_at > price)) d.compare_at = null; // an "old price" must be higher than the price to mean anything
  if (has('stock_qty') || !existing) { const n = num(b.stock_qty, { min: 0, max: 1e7, name: 'Stock' }); d.stock_qty = n == null ? null : Math.trunc(n); }
  if (has('sizes') || !existing) d.sizes = list(b.sizes, 30, 30);
  if (has('colours') || !existing) d.colours = list(b.colours, 30, 30);
  if (has('images') || !existing) {
    const imgs = (Array.isArray(b.images) ? b.images : []).map(u => String(u).trim()).filter(Boolean).slice(0, 8);
    if (imgs.some(u => u.length > 600 || !/^(https?:\/\/|\/)/.test(u))) throw new HttpError(400, 'Photos must be web links (https)');
    d.images = imgs;
  }
  if (has('specs') || !existing) d.specs = str(b.specs, 3000) || null;
  if (has('tags') || !existing) d.tags = str(b.tags, 300) || null;
  if (has('active') || !existing) d.active = b.active === undefined ? true : !!bool(b.active);
  return d;
}
const dropOwnedImages = urls => Promise.all(urls.map(u => supa.objectNameFromUrl(u)).filter(Boolean).map(n => supa.deleteObject(n)));

module.exports = (r) => {
  r.get('/api/admin/stats', admin, async ctx => {
    const c = async (sql, ...p) => (await q.get(sql, ...p)).c, gmv = await q.get(`SELECT COALESCE(SUM(total),0) v, COUNT(*) n FROM orders WHERE status IN ${PAID}`), gmv30 = await q.get(`SELECT COALESCE(SUM(total),0) v, COUNT(*) n FROM orders WHERE status IN ${PAID} AND paid_at > datetime('now','-30 days')`);
    let products = null, low = [], error = null;
    try { const rows = (await catalog.ensure()).rows; products = { total: rows.length, live: rows.filter(p => p.active).length }; low = rows.filter(p => p.active && p.stock_qty != null && p.stock_qty <= 3).slice(0, 10).map(p => ({ id: p.id, name: p.name, stock_qty: p.stock_qty })); } catch (e) { error = e.message; }
    return { supabase: { ...catalog.status(), url: cfg.supabaseUrl || null, error: error || catalog.status().error }, products, low_stock: low,
      sales: { orders: gmv.n, revenue: gmv.v, orders_30d: gmv30.n, revenue_30d: gmv30.v, to_fulfil: await c("SELECT COUNT(*) c FROM orders WHERE status IN ('paid','processing')"), refunded: await c("SELECT COUNT(*) c FROM orders WHERE status='refunded'") },
      customers: await c("SELECT COUNT(*) c FROM users WHERE role='customer'"), open_support: await c("SELECT COUNT(*) c FROM support_requests WHERE status='open'"),
      system: { payments: cfg.paystackKey ? 'paystack' : 'demo mode', demo_payments: cfg.demoPayments && !cfg.paystackKey, uptime_s: Math.round(process.uptime()), memory_mb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, load: os.loadavg()[0].toFixed(2) } };
  });

  // ---------- products ----------
  r.get('/api/admin/products', admin, async ctx => {
    const rows = (await catalog.load(true), await catalog.ensure()).rows, sold = await catalog.soldMap(), ratings = await catalog.ratingMap();
    return { items: rows.map(p => catalog.shapeAdmin(p, sold, ratings)), categories: catalog.categoriesOf(rows).map(c => c.name) };
  });
  r.post('/api/admin/products', admin, async ctx => {
    const p = await catalog.create(productData(ctx.body, null)); await audit(ctx.user.id, 'product.create', `${p.id} ${p.name}`); return catalog.shapeAdmin(p, await catalog.soldMap(), await catalog.ratingMap());
  });
  r.put('/api/admin/products/:id', admin, async ctx => {
    const id = +ctx.params.id, old = (await catalog.ensure()).byId.get(id); if (!old) throw new HttpError(404, 'Product not found');
    const d = productData(ctx.body, old), p = await catalog.update(id, d);
    if (d.images) dropOwnedImages(old.images.filter(u => !d.images.includes(u))).catch(() => {});
    await audit(ctx.user.id, 'product.update', `${id} ${p.name}`); return catalog.shapeAdmin(p, await catalog.soldMap(), await catalog.ratingMap());
  });
  r.delete('/api/admin/products/:id', admin, async ctx => {
    const id = +ctx.params.id, old = (await catalog.ensure()).byId.get(id); if (!old) throw new HttpError(404, 'Product not found');
    await catalog.remove(id); dropOwnedImages(old.images).catch(() => {}); await audit(ctx.user.id, 'product.delete', `${id} ${old.name}`); return { ok: true };
  });
  // The browser resizes the photo first; the server stores it in the Supabase bucket and returns its public URL.
  r.post('/api/admin/uploads', admin, async ctx => {
    const m = String(ctx.body.data_url || '').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new HttpError(400, 'Upload a PNG, JPEG or WebP image');
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 3 * 1024 * 1024) throw new HttpError(413, 'Image is too large (max 3 MB after resizing)');
    const magic = buf.subarray(0, 4).toString('hex');
    if (!(magic.startsWith('89504e47') || magic.startsWith('ffd8ff') || buf.subarray(0, 4).toString() === 'RIFF')) throw new HttpError(400, 'File is not a valid image');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1], name = `${new Date().toISOString().slice(0, 7)}/${crypto.randomBytes(12).toString('hex')}.${ext}`;
    return { url: await supa.uploadObject(name, buf, 'image/' + m[1]) };
  });

  // ---------- orders ----------
  r.get('/api/admin/orders', admin, async ctx => {
    const st = str(ctx.query.status, 30), where = st ? 'status=?' : "status!='pending_payment'";
    return Promise.all((await q.all(`SELECT * FROM orders WHERE ${where} ORDER BY id DESC LIMIT 200`, ...(st ? [st] : []))).map(async o => ({ ...(await summary(o)), id: o.id, phone: o.customer_phone, email: o.customer_email })));
  });
  r.post('/api/admin/orders/:id/status', admin, async ctx => {
    const o = await q.get('SELECT * FROM orders WHERE id=?', +ctx.params.id), s = ctx.body.status;
    if (!o) throw new HttpError(404, 'Order not found');
    if (!['processing', 'ready', 'dispatched', 'completed'].includes(s)) throw new HttpError(400, 'Invalid status');
    if (!['paid', 'processing', 'ready', 'dispatched', 'completed'].includes(o.status)) throw new HttpError(400, 'This order cannot be changed');
    await q.run('UPDATE orders SET status=? WHERE id=?', s, o.id); await audit(ctx.user.id, 'order.' + s, o.reference);
    const shop = shopSettings().shop_name;
    if (o.customer_id) await notify(o.customer_id, `Order ${o.reference} is ${s}`, `${shop} updated your order.`, `/#/order/${o.reference}`);
    mail.send(o.customer_email, `Order ${o.reference}: ${s}`, `Hi ${o.customer_name}, your order ${o.reference} from ${shop} is now: ${s}.`);
    return { ok: true };
  });
  r.post('/api/admin/orders/:id/refund', admin, async ctx => {
    const o = await q.get('SELECT * FROM orders WHERE id=?', +ctx.params.id);
    if (!o) throw new HttpError(404, 'Order not found');
    if (!['paid', 'processing', 'ready', 'dispatched', 'completed'].includes(o.status)) throw new HttpError(400, 'This order cannot be refunded');
    let refId = '';
    if (cfg.paystackKey) {
      try { const res = await ps('/refund', { method: 'POST', body: JSON.stringify({ transaction: o.reference, merchant_note: 'Refund from ' + shopSettings().shop_name }) }), j = await res.json(); if (!res.ok || !j.status) throw new Error(j.message || 'refused'); refId = String(j.data?.id || ''); }
      catch (e) { throw new HttpError(502, 'Paystack could not process the refund: ' + String(e.message).slice(0, 120) + '. You can also refund from your Paystack dashboard.'); }
    }
    await q.run("UPDATE orders SET status='refunded', refund_ref=? WHERE id=?", refId, o.id);
    for (const it of await q.all('SELECT * FROM order_items WHERE order_id=?', o.id)) if (it.product_id) { try { await catalog.adjustStock(it.product_id, it.qty); } catch (e) { console.error('[stock] restock failed', it.product_id, e.message); } }
    await audit(ctx.user.id, 'order.refund', o.reference);
    mail.send(o.customer_email, `Refund for order ${o.reference}`, `Hi ${o.customer_name}, ${money(o.total)} is being refunded to your original payment method. Banks can take a few days to show it.`);
    return { ok: true };
  });

  // ---------- customers, support ----------
  r.get('/api/admin/users', admin, async ctx => await q.all(`SELECT u.id,u.role,u.name,u.email,u.phone,u.suspended,u.created_at,(SELECT COUNT(*) FROM orders o WHERE o.customer_id=u.id AND o.status IN ${PAID}) orders FROM users u ORDER BY u.id DESC LIMIT 300`));
  r.patch('/api/admin/users/:id', admin, async ctx => {
    const u = await q.get('SELECT * FROM users WHERE id=?', +ctx.params.id); if (!u) throw new HttpError(404, 'Not found');
    if (u.role === 'admin') throw new HttpError(400, 'Admin accounts cannot be suspended here');
    await q.run('UPDATE users SET suspended=? WHERE id=?', bool(ctx.body.suspended), u.id); await audit(ctx.user.id, ctx.body.suspended ? 'user.suspend' : 'user.restore', `${u.id} ${u.email}`);
    return { ok: true };
  });
  r.get('/api/admin/support', admin, async ctx => await q.all(`SELECT s.*, u.name user_name, u.email user_email FROM support_requests s JOIN users u ON u.id=s.user_id ORDER BY (s.status='open') DESC, s.id DESC LIMIT 200`));
  r.post('/api/admin/support/:id/reply', admin, async ctx => {
    const s = await q.get('SELECT * FROM support_requests WHERE id=?', +ctx.params.id); if (!s) throw new HttpError(404, 'Not found');
    const reply = str(ctx.body.reply, 2000, { required: true, name: 'Reply' });
    await q.run("UPDATE support_requests SET admin_reply=?, status='closed' WHERE id=?", reply, s.id); await notify(s.user_id, `Support reply: ${s.subject}`, reply.slice(0, 200)); return { ok: true };
  });

  // ---------- discount codes ----------
  r.get('/api/admin/discounts', admin, async ctx => await q.all('SELECT * FROM discount_codes ORDER BY id DESC'));
  r.post('/api/admin/discounts', admin, async ctx => {
    const d = ctx.body, code = str(d.code, 20, { required: true, name: 'Code' }).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) throw new HttpError(400, 'Code must be 3-20 letters or numbers');
    const kind = d.kind === 'fixed' ? 'fixed' : 'percent', value = +d.value;
    if (!(value > 0) || (kind === 'percent' && value > 90)) throw new HttpError(400, kind === 'percent' ? 'Percent must be between 1 and 90' : 'Enter an amount above 0');
    try { await q.run('INSERT INTO discount_codes(code,kind,value,min_order,max_uses,expires_on) VALUES(?,?,?,?,?,?)', code, kind, value, Math.max(0, +d.min_order || 0), +d.max_uses > 0 ? Math.trunc(+d.max_uses) : null, /^\d{4}-\d{2}-\d{2}$/.test(d.expires_on || '') ? d.expires_on : null); }
    catch { throw new HttpError(409, 'You already have that code'); }
    return { ok: true };
  });
  r.delete('/api/admin/discounts/:id', admin, async ctx => { await q.run('DELETE FROM discount_codes WHERE id=?', +ctx.params.id); return { ok: true }; });

  // ---------- shop settings ----------
  r.get('/api/admin/settings', admin, async ctx => ({ ...shopSettings(), defaults: SHOP_DEFAULTS }));
  r.put('/api/admin/settings', admin, async ctx => {
    const b = ctx.body, cur = shopSettings(), fo = b.free_delivery_over === '' || b.free_delivery_over == null ? null : num(b.free_delivery_over, { min: 0, max: 1e9, name: 'Free delivery threshold' });
    await setSetting('shop', { shop_name: str(b.shop_name, 60) || cur.shop_name, delivery_fee: num(b.delivery_fee, { min: 0, max: 1e7, name: 'Delivery fee' }) ?? 0, free_delivery_over: fo, offers_pickup: !!bool(b.offers_pickup), pickup_info: str(b.pickup_info, 300),
      phone: str(b.phone, 30), whatsapp: str(b.whatsapp, 30), returns_policy: str(b.returns_policy, 600) });
    await audit(ctx.user.id, 'settings.shop', ''); return { ok: true };
  });
  r.get('/api/admin/audit', admin, async ctx => await q.all('SELECT a.*, u.email actor FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100'));
};
