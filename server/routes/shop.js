// Checkout and orders. One shop, one Paystack account. Prices and totals are always computed on the server from the catalogue.
// An order is only marked paid after the amount is verified with Paystack (return-page check or signed webhook), never because the browser says so.
const crypto = require('crypto');
const { q } = require('../db');
const { shopSettings, notify } = require('../db');
const cfg = require('../config');
const { HttpError } = require('../http');
const { requireAuth, userFromReq } = require('../auth');
const { str } = require('../util');
const catalog = require('../catalog');
const mail = require('../mail');
const { ps } = require('../paystack');

const origin = ctx => process.env.APP_URL || process.env.PUBLIC_URL || `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host}`;
const money = n => '₦' + Math.round(n).toLocaleString();

async function price(subtotal, method, code) {
  const s = shopSettings(); let discount = 0, dc = null;
  if (code) {
    dc = await q.get('SELECT * FROM discount_codes WHERE code=? AND active=1', String(code).trim().toUpperCase());
    if (!dc || (dc.expires_on && dc.expires_on < new Date().toISOString().slice(0, 10)) || (dc.max_uses != null && dc.used >= dc.max_uses)) throw new HttpError(400, 'That discount code is not valid');
    if (subtotal < dc.min_order) throw new HttpError(400, `This code needs an order of at least ${money(dc.min_order)}`);
    discount = dc.kind === 'percent' ? Math.round(subtotal * dc.value / 100) : Math.min(dc.value, subtotal);
  }
  const after = subtotal - discount, free = s.free_delivery_over != null && s.free_delivery_over !== '' && after >= +s.free_delivery_over, fee = method === 'delivery' && !free ? (+s.delivery_fee || 0) : 0;
  return { subtotal, discount, fee, total: after + fee, code: dc ? dc.code : null };
}

// Mark an order paid exactly once, only if Paystack's verified data matches what we expect. Then take the items out of stock in Supabase.
async function settle(order, tx) {
  if (order.status !== 'pending_payment') return order;
  if (!tx || tx.status !== 'success' || Math.round(tx.amount) !== Math.round(order.total * 100) || (tx.currency && tx.currency !== 'NGN')) return order;
  const won = await q.tx(async () => {
    const res = await q.run("UPDATE orders SET status='paid', paid_at=datetime('now') WHERE id=? AND status='pending_payment'", order.id);
    if (!res.changes) return false;
    if (order.discount_code) await q.run('UPDATE discount_codes SET used=used+1 WHERE code=?', order.discount_code);
    await q.run('UPDATE order_items SET unit_cost=(SELECT cost FROM product_costs pc WHERE pc.product_id=order_items.product_id) WHERE order_id=?', order.id); // accounting: freeze the cost of goods sold
    return true;
  });
  if (!won) return await q.get('SELECT * FROM orders WHERE id=?', order.id);
  const items = await q.all('SELECT * FROM order_items WHERE order_id=?', order.id), problems = [];
  for (const it of items) {
    if (!it.product_id) continue;
    try { const row = (await catalog.ensure()).byId.get(it.product_id); if (row && row.stock_qty != null && row.stock_qty < it.qty) problems.push(`${it.name} (only ${row.stock_qty} were in stock)`); await catalog.adjustStock(it.product_id, -it.qty); }
    catch (e) { console.error('[stock] could not update', it.product_id, e.message); problems.push(`${it.name} (stock not updated)`); }
  }
  if (problems.length) await q.run('UPDATE orders SET note=? WHERE id=?', 'Paid, but check stock: ' + problems.join(', ') + '. Refund from Orders if you cannot supply it.', order.id);
  const o2 = await q.get('SELECT * FROM orders WHERE id=?', order.id), shop = shopSettings(), lines = items.map(i => `${i.qty} x ${i.name}${i.variant ? ' (' + i.variant + ')' : ''}  ${money(i.qty * i.unit_price)}`).join('\n');
  for (const a of await q.all("SELECT id FROM users WHERE role='admin'")) await notify(a.id, 'New paid order', `${order.customer_name} paid ${money(order.total)} (${order.reference})`, '/admin.html#/admin/orders');
  mail.send(order.customer_email, `Your order ${order.reference} is confirmed`, `Hi ${order.customer_name},\n\nThanks for your order from ${shop.shop_name}. Payment received.\n\n${lines}\nDelivery: ${money(o2.delivery_fee || 0)}\nDiscount: -${money(o2.discount || 0)}\nTotal paid: ${money(order.total)}\n\n${order.method === 'delivery' ? 'Delivery to: ' + order.address : 'Pickup: ' + (shop.pickup_info || 'we will tell you when it is ready')}\nReference: ${order.reference}`);
  mail.send(cfg.adminEmail, `New paid order ${order.reference}`, `${order.customer_name} (${order.customer_phone}) paid ${money(order.total)}.\n\n${lines}\n\n${order.method === 'delivery' ? 'Deliver to: ' + order.address : 'Pickup'}${problems.length ? '\n\nCheck stock: ' + problems.join(', ') : ''}`);
  return o2;
}

const summary = async o => ({ reference: o.reference, status: o.status, total: o.total, subtotal: o.subtotal, delivery_fee: o.delivery_fee, discount: o.discount, discount_code: o.discount_code, shop: shopSettings().shop_name, method: o.method, address: o.address, customer_name: o.customer_name, created_at: o.created_at, note: o.note,
  items: (await q.all('SELECT name, qty, unit_price, variant, product_id, image FROM order_items WHERE order_id=?', o.id)).map(i => ({ ...i, image: i.image || (i.product_id ? `/api/placeholder/${i.product_id}.svg` : null) })) });

// Read the cart lines against fresh catalogue data (throws a plain message for anything unavailable).
async function priceLines(rawItems, { fresh }) {
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 30) throw new HttpError(400, 'Your cart is empty');
  const ids = rawItems.map(i => +i.product_id), byId = fresh ? await catalog.fetchFresh(ids) : (await catalog.ensure()).byId, want = new Map(), lines = []; let subtotal = 0;
  for (const it of rawItems) {
    const qty = Math.trunc(+it.qty), p = byId.get(+it.product_id);
    if (!p || !p.active || p.price == null || !(qty >= 1 && qty <= 100)) throw new HttpError(400, 'One of the items in your cart is no longer available');
    let variant; try { variant = catalog.variantLabel(p, str(it.size, 30), str(it.colour, 30)); } catch (e) { throw new HttpError(400, e.message); }
    const total = (want.get(p.id) || 0) + qty; want.set(p.id, total);
    if (p.stock_qty != null && p.stock_qty < total) throw new HttpError(400, p.stock_qty > 0 ? `Only ${p.stock_qty} of ${p.name} left` : `${p.name} is out of stock`);
    subtotal += p.price * qty; lines.push([p, qty, variant]);
  }
  return { lines, subtotal };
}

module.exports = function (r) {
  r.get('/api/shop/my-orders', requireAuth('customer'), async ctx => Promise.all((await q.all("SELECT * FROM orders WHERE customer_id=? AND status!='pending_payment' ORDER BY id DESC LIMIT 50", ctx.user.id)).map(summary)));

  r.post('/api/shop/quote', async ctx => {
    const byId = (await catalog.ensure()).byId; let subtotal = 0;
    for (const it of Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 30) : []) { const p = byId.get(+it.product_id); if (p && p.active && p.price != null) subtotal += p.price * Math.max(1, Math.min(100, Math.trunc(+it.qty) || 1)); }
    const method = ctx.body.method === 'pickup' && shopSettings().offers_pickup ? 'pickup' : 'delivery';
    return await price(subtotal, method, ctx.body.code || null);
  });

  r.post('/api/shop/checkout', async ctx => {
    const d = ctx.body;
    if (!cfg.paystackKey && !cfg.demoPayments) throw new HttpError(409, 'Online payments are not switched on yet. Please contact the shop to order.');
    const name = str(d.name, 80, { required: true, name: 'Name' }), phone = str(d.phone, 30, { required: true, name: 'Phone' }), email = str(d.email, 120, { required: true, name: 'Email' }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email so Paystack can send your receipt');
    const method = d.method === 'pickup' && shopSettings().offers_pickup ? 'pickup' : 'delivery', address = method === 'delivery' ? str(d.address, 200, { required: true, name: 'Delivery address' }) : null;
    const { lines, subtotal } = await priceLines(d.items, { fresh: true }), pr = await price(subtotal, method, d.code), total = pr.total;
    if (total < 100) throw new HttpError(400, 'The order total is too small to pay online');
    const reference = 'SO' + crypto.randomBytes(9).toString('hex'), cu = await userFromReq(ctx.req);
    const id = await q.tx(async () => {
      const oid = (await q.run('INSERT INTO orders(reference,customer_id,customer_name,customer_phone,customer_email,method,address,subtotal,delivery_fee,discount,discount_code,total) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        reference, cu && cu.role === 'customer' ? cu.id : null, name, phone, email, method, address, pr.subtotal, pr.fee, pr.discount, pr.code, total)).lastInsertRowid;
      for (const [p, qty, variant] of lines) await q.run('INSERT INTO order_items(order_id,product_id,name,variant,image,qty,unit_price) VALUES(?,?,?,?,?,?,?)', oid, p.id, p.name, variant, p.images[0] || null, qty, p.price);
      return oid;
    });
    if (!cfg.paystackKey) { // demo payments (no real money): settle immediately
      await settle(await q.get('SELECT * FROM orders WHERE id=?', id), { status: 'success', amount: Math.round(total * 100), currency: 'NGN' });
      return { reference, authorization_url: `${origin(ctx)}/order.html?ref=${reference}`, total, demo: true };
    }
    let res; try { res = await ps('/transaction/initialize', { method: 'POST', body: JSON.stringify({ email, amount: Math.round(total * 100), currency: 'NGN', reference, callback_url: `${origin(ctx)}/order.html?ref=${reference}`, metadata: { order_id: id } }) }); } catch { res = null; }
    const j = res && res.ok ? await res.json() : null;
    if (!j || !j.data?.authorization_url) { await q.run("UPDATE orders SET status='cancelled', note='Payment could not be started' WHERE id=?", id); throw new HttpError(502, 'We could not start the payment. Please try again.'); }
    return { reference, authorization_url: j.data.authorization_url, total };
  });

  r.get('/api/shop/order/:reference', async ctx => {
    let o = await q.get('SELECT * FROM orders WHERE reference=?', ctx.params.reference);
    if (!o) throw new HttpError(404, 'Order not found');
    if (o.status === 'pending_payment' && cfg.paystackKey) { try { const j = await (await ps('/transaction/verify/' + encodeURIComponent(o.reference))).json(); o = await settle(o, j.data); } catch (e) { console.error('[shop] verify failed', e.message); } }
    return await summary(o);
  });

  r.post('/api/webhooks/paystack', async ctx => {
    if (!cfg.paystackKey) throw new HttpError(404, 'Not configured');
    const sig = String(ctx.req.headers['x-paystack-signature'] || ''), want = crypto.createHmac('sha512', cfg.paystackKey).update(ctx.rawBody).digest('hex');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) throw new HttpError(401, 'Bad signature');
    if (ctx.body.event === 'charge.success') { const o = await q.get('SELECT * FROM orders WHERE reference=?', ctx.body.data?.reference); if (o) await settle(o, ctx.body.data); }
    return { ok: true };
  });
};
module.exports.summary = summary;
module.exports.money = money;
