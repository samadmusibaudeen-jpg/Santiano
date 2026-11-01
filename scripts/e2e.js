// End-to-end test: the real shop server against the mock Supabase. Run with: npm test
'use strict';
const path = require('path'), os = require('os'), fs = require('fs'), http = require('http'), crypto = require('crypto');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-e2e-'));
Object.assign(process.env, { DB_PATH: path.join(tmp, 'test.db'), PAYSTACK_SECRET_KEY: '', APP_SECRET: 'test-secret-1234567890', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin-pass-123', SUPABASE_SERVICE_ROLE_KEY: 'mock-key' });
delete process.env.DEMO_PAYMENTS;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m); } else { fail++; console.log('FAIL ' + m); } };
(async () => {
  const mock = await require('./mock-supabase').start(0, 'mock-key'), mport = mock.server.address().port;
  process.env.SUPABASE_URL = 'http://localhost:' + mport;
  const { handle } = require('../server');
  const app = http.createServer(handle); await new Promise(r => app.listen(0, r)); const base = 'http://localhost:' + app.address().port;
  const call = async (method, p, body, token, headers = {}) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }); let j = null; try { j = await res.json(); } catch {} return { s: res.status, j }; };
  const login = async (email, password, portal) => (await call('POST', '/api/auth/login', { email, password, portal })).j;

  // --- setup state ---
  ok((await call('GET', '/api/health')).s === 200, 'health');
  const admin = (await login('admin@test.local', 'admin-pass-123', 'admin')).token; ok(!!admin, 'admin signs in');
  ok((await call('GET', '/api/admin/products')).s === 401, 'admin API needs a token');
  const reg = (await call('POST', '/api/auth/register', { name: 'Ada Obi', email: 'ada@test.ng', password: 'password1', phone: '0803' })).j; const cust = reg.token; ok(reg.user.role === 'customer', 'customer registers');
  ok((await call('GET', '/api/admin/products', undefined, cust)).s === 403, 'customer cannot use admin API');
  ok((await call('POST', '/api/auth/register', { name: 'X', email: 'x@test.ng', password: 'password1', role: 'admin' })).j.user.role === 'customer', 'cannot self-register as admin');
  const empty = (await call('GET', '/api/market/home')).j; ok(empty.totals.products === 0 && empty.categories.length === 0, 'shop starts empty (no demo products)');
  const st0 = (await call('GET', '/api/admin/stats', undefined, admin)).j; ok(st0.supabase.configured && st0.products.total === 0, 'admin stats see Supabase');

  // --- admin uploads goods ---
  const up = (await call('POST', '/api/admin/uploads', { data_url: PNG }, admin)); ok(up.s === 200 && up.j.url.includes('/storage/v1/object/public/product-images/'), 'photo upload goes to Supabase Storage');
  ok(mock.state.objects.size === 1, 'photo stored in the bucket'); const img = await fetch(up.j.url); ok(img.status === 200, 'photo is publicly reachable');
  ok((await call('POST', '/api/admin/uploads', { data_url: 'data:text/html;base64,PGI+' }, admin)).s === 400, 'non-images rejected');
  ok((await call('POST', '/api/admin/products', { name: '', price: 10 }, admin)).s === 400, 'product needs a name');
  ok((await call('POST', '/api/admin/products', { name: 'X', price: -5 }, admin)).s === 400, 'price cannot be negative');
  const p1 = (await call('POST', '/api/admin/products', { name: 'Classic Black Sneakers', description: 'Comfy everyday sneakers', category: 'Footwear', price: 22000, compare_at: 28000, stock_qty: 5, sizes: '40, 41, 42', colours: ['Black'], images: [up.j.url], tags: 'shoes trainers' }, admin)).j;
  ok(p1.id && p1.price === 22000 && p1.sizes.length === 3 && p1.discount_pct === 21, 'create product (sizes parsed, discount computed)');
  const p2 = (await call('POST', '/api/admin/products', { name: 'Wireless Earbuds', category: 'Electronics', price: 15000, stock_qty: null }, admin)).j; ok(p2.in_stock, 'untracked stock is always available');
  const p3 = (await call('POST', '/api/admin/products', { name: 'Hidden Draft Item', category: 'Electronics', price: 9000, active: false }, admin)).j;
  const bad = (await call('POST', '/api/admin/products', { name: 'Odd', price: 100, compare_at: 50 }, admin)).j; ok(bad.compare_at === null, 'old price lower than price is ignored');
  ok(mock.state.products.length === 4, 'rows exist in Supabase');

  // --- shopper browsing ---
  await new Promise(r => setTimeout(r, 50));
  const home = (await call('GET', '/api/market/home')).j; ok(home.totals.products === 3 && home.deals.length === 1 && home.new_arrivals.length === 3, 'home shows live products only');
  ok(!home.new_arrivals.some(p => p.id === p3.id), 'inactive product hidden from the shop');
  ok((await call('GET', '/api/market/products/' + p3.id)).s === 404, 'inactive product page is 404');
  ok(JSON.stringify(home.categories.map(c => c.name).sort()) === '["Electronics","Footwear"]', 'categories come from products');
  const sr = (await call('GET', '/api/market/products?q=trainers')).j; ok(sr.total === 1 && sr.items[0].id === p1.id, 'search matches tags');
  ok((await call('GET', '/api/market/products?category=Electronics&sort=price_desc')).j.items[0].id === p2.id, 'category filter + sort');
  ok((await call('GET', '/api/market/products?min=20000')).j.total === 1, 'price filter');
  ok((await call('GET', '/api/market/products?deals=1')).j.total === 1, 'deals filter');
  ok((await call('GET', '/api/market/suggest?q=wire')).j.products.length === 1, 'search suggestions');
  const pd = (await call('GET', '/api/market/products/' + p1.id)).j; ok(pd.product.image === up.j.url && pd.shop.delivery_fee === 2000 && pd.related.length === 2, 'product page (photo, shop delivery info, related)');
  const cart0 = (await call('POST', '/api/market/cart', { items: [{ product_id: p1.id, qty: 9, size: '41', colour: 'Black' }, { product_id: p2.id, qty: 1 }, { product_id: 9999, qty: 1 }] })).j;
  ok(cart0.items[0].qty === 5 && /Only 5 left/.test(cart0.items[0].problem) && cart0.items[2].problem === 'No longer available', 'cart caps quantity to stock and flags missing items');
  ok(cart0.subtotal === 5 * 22000 + 15000, 'cart subtotal re-priced on the server');

  // --- discount codes + delivery settings ---
  ok((await call('POST', '/api/admin/discounts', { code: 'save10', kind: 'percent', value: 10 }, admin)).s === 200, 'admin creates a code');
  ok((await call('PUT', '/api/admin/settings', { shop_name: 'Santiano', delivery_fee: 1500, free_delivery_over: 100000, offers_pickup: false }, admin)).s === 200, 'admin saves delivery settings');
  const items = [{ product_id: p1.id, qty: 2, size: '41', colour: 'Black' }];
  const q1 = (await call('POST', '/api/shop/quote', { items, method: 'delivery', code: 'SAVE10' })).j; ok(q1.subtotal === 44000 && q1.discount === 4400 && q1.fee === 1500 && q1.total === 41100, 'quote: discount and delivery fee');
  ok((await call('POST', '/api/shop/quote', { items, method: 'pickup' })).j.fee === 1500, 'pickup ignored while the shop does not offer it');
  ok((await call('POST', '/api/shop/quote', { items: [{ product_id: p1.id, qty: 5, size: '41', colour: 'Black' }], method: 'delivery' })).j.fee === 0, 'free delivery over threshold');

  // --- checkout (demo payments) ---
  const body = { name: 'Ada Obi', phone: '0803', email: 'ada@test.ng', method: 'delivery', address: '12 Allen Ave, Ikeja', items, code: 'SAVE10' };
  ok((await call('POST', '/api/shop/checkout', { ...body, items: [{ product_id: p1.id, qty: 2 }] }, cust)).s === 400, 'checkout requires size/colour choice');
  ok((await call('POST', '/api/shop/checkout', { ...body, items: [{ product_id: p1.id, qty: 6, size: '41', colour: 'Black' }] }, cust)).s === 400, 'checkout refuses more than stock');
  ok((await call('POST', '/api/shop/checkout', { ...body, address: '' }, cust)).s === 400, 'delivery needs an address');
  const co = await call('POST', '/api/shop/checkout', body, cust); ok(co.s === 200 && co.j.total === 41100 && co.j.demo, 'checkout creates and pays a demo order');
  const ord = (await call('GET', '/api/shop/order/' + co.j.reference)).j; ok(ord.status === 'paid' && ord.items[0].image === up.j.url && ord.shop === 'Santiano', 'order is paid with item snapshot');
  ok(mock.state.products.find(p => p.id === p1.id).stock_qty === 3, 'stock reduced in Supabase');
  ok((await call('GET', '/api/admin/discounts', undefined, admin)).j[0].used === 1, 'discount code use counted');
  ok((await call('GET', '/api/shop/my-orders', undefined, cust)).j.length === 1, 'customer sees own order');
  ok((await call('GET', '/api/me', undefined, admin)).j.unread >= 1, 'admin notified of the new order');
  ok((await call('POST', '/api/market/products/' + p1.id + '/reviews', { rating: 5, title: 'Great' }, cust)).s === 200, 'buyer can review');
  ok((await call('POST', '/api/market/products/' + p2.id + '/reviews', { rating: 5 }, cust)).s === 403, 'non-buyer cannot review');
  ok((await call('GET', '/api/market/products/' + p1.id)).j.product.rating_avg === 5, 'rating shown on product');

  // --- admin fulfils and refunds ---
  const ol = (await call('GET', '/api/admin/orders', undefined, admin)).j; ok(ol.length === 1 && ol[0].phone === '0803', 'admin sees the order and the customer details');
  ok((await call('POST', `/api/admin/orders/${ol[0].id}/status`, { status: 'dispatched' }, admin)).s === 200, 'admin updates order status');
  ok((await call('GET', '/api/shop/order/' + co.j.reference)).j.status === 'dispatched', 'customer sees the new status');
  ok((await call('POST', `/api/admin/orders/${ol[0].id}/refund`, {}, admin)).s === 200, 'admin refunds');
  ok(mock.state.products.find(p => p.id === p1.id).stock_qty === 5, 'refund puts stock back in Supabase');
  ok((await call('POST', `/api/admin/orders/${ol[0].id}/refund`, {}, admin)).s === 400, 'cannot refund twice');

  // --- paystack webhook path (signature + verified amount) ---
  const cfg = require('../server/config'), { q } = require('../server/db'); cfg.paystackKey = 'sk_test_webhook';
  q.run("INSERT INTO orders(reference,customer_name,customer_phone,customer_email,method,address,subtotal,total) VALUES('SOWEBHOOK1','W','1','w@t.ng','delivery','x',1000,1000)");
  const oid = q.get("SELECT id FROM orders WHERE reference='SOWEBHOOK1'").id; q.run('INSERT INTO order_items(order_id,product_id,name,qty,unit_price) VALUES(?,?,?,?,?)', oid, p1.id, 'Classic Black Sneakers', 1, 1000);
  const mkEv = amount => { const raw = JSON.stringify({ event: 'charge.success', data: { reference: 'SOWEBHOOK1', status: 'success', amount, currency: 'NGN' } }); return [raw, crypto.createHmac('sha512', 'sk_test_webhook').update(raw).digest('hex')]; };
  let [raw, sig] = mkEv(100000);
  ok((await call('POST', '/api/webhooks/paystack', raw, null, { 'x-paystack-signature': 'bad' })).s === 401, 'webhook rejects a bad signature');
  await call('POST', '/api/webhooks/paystack', mkEv(5)[0], null, { 'x-paystack-signature': mkEv(5)[1] }); ok(q.get('SELECT status FROM orders WHERE id=?', oid).status === 'pending_payment', 'webhook ignores a wrong amount');
  await call('POST', '/api/webhooks/paystack', raw, null, { 'x-paystack-signature': sig }); await call('POST', '/api/webhooks/paystack', raw, null, { 'x-paystack-signature': sig });
  ok(q.get('SELECT status FROM orders WHERE id=?', oid).status === 'paid', 'webhook marks the order paid');
  ok(mock.state.products.find(p => p.id === p1.id).stock_qty === 4, 'webhook replay does not take stock twice'); cfg.paystackKey = '';

  // --- editing and deleting products ---
  const up2 = (await call('POST', '/api/admin/uploads', { data_url: PNG }, admin)).j.url;
  const ed = await call('PUT', '/api/admin/products/' + p1.id, { price: 19000, images: [up2], stock_qty: 10 }, admin); ok(ed.s === 200 && ed.j.price === 19000 && ed.j.image === up2, 'edit price, stock and photos');
  await new Promise(r => setTimeout(r, 100)); ok(!mock.state.objects.has(up.j.url.split('/product-images/')[1]), 'replaced photo is removed from the bucket');
  ok((await call('PUT', '/api/admin/products/' + p2.id, { active: false }, admin)).j.active === false, 'hide a product');
  await new Promise(r => setTimeout(r, 30)); const lst = (await call('GET', '/api/market/products')).j; ok(lst.total === 2 && !lst.items.some(i => i.id === p2.id), 'hidden product leaves the shop');
  ok((await call('DELETE', '/api/admin/products/' + p1.id, undefined, admin)).s === 200 && mock.state.products.every(p => p.id !== p1.id), 'delete a product');
  ok((await call('POST', '/api/shop/checkout', { ...body, items: [{ product_id: p1.id, qty: 1, size: '41', colour: 'Black' }] }, cust)).s === 400, 'deleted product cannot be bought');

  // --- Supabase outage keeps the shop browsable from cache ---
  mock.server.close(); await new Promise(r => setTimeout(r, 16000));
  ok((await call('GET', '/api/market/home')).s === 200, 'shop keeps serving cached products when Supabase is unreachable');
  ok((await call('POST', '/api/admin/products', { name: 'Z', price: 5 }, admin)).s === 502, 'admin gets a clear error when Supabase is down');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
