// Public shop API: home, browse/search, product pages, reviews, cart re-pricing.
const { q } = require('../db');
const { HttpError, rateLimit } = require('../http');
const { userFromReq, requireAuth } = require('../auth');
const catalog = require('../catalog');
const { publicShop } = require('./public');
const { str, num } = require('../util');

const reviewerName = n => { const w = String(n || 'Customer').trim().split(/\s+/); return w[0] + (w[1] ? ' ' + w[1][0] + '.' : ''); };

module.exports = function (r) {
  r.get('/api/market/home', async ctx => {
    const c = await catalog.ensure(), rows = catalog.live(c.rows), ratings = await catalog.ratingMap(), sold = await catalog.soldMap(), sh = p => catalog.shape(p, ratings, sold);
    const dealRows = rows.filter(p => p.compare_at != null && p.compare_at > p.price).sort((a, b) => (b.compare_at - b.price) / b.compare_at - (a.compare_at - a.price) / a.compare_at);
    const best = catalog.sortRows(rows.filter(p => (sold.get(p.id) || 0) > 0), 'popular', sold, ratings);
    return { categories: catalog.categoriesOf(rows), deals: dealRows.slice(0, 12).map(sh), best_sellers: best.slice(0, 12).map(sh), new_arrivals: [...rows].sort((a, b) => b.id - a.id).slice(0, 12).map(sh),
      totals: { products: rows.length }, shop: publicShop() };
  });

  r.get('/api/market/products', async ctx => {
    const Q = ctx.query, per = Math.min(48, Math.max(1, +Q.per || 24)), page = Math.max(1, +Q.page || 1);
    const rows = catalog.live((await catalog.ensure()).rows), ratings = await catalog.ratingMap(), sold = await catalog.soldMap();
    const matched = catalog.filterRows(rows, Q), sorted = catalog.sortRows(matched, Q.sort, sold, ratings);
    const base = catalog.filterRows(rows, { ...Q, category: '' }), prices = base.map(p => p.price);
    return { items: sorted.slice((page - 1) * per, page * per).map(p => catalog.shape(p, ratings, sold)), total: sorted.length, page, pages: Math.max(1, Math.ceil(sorted.length / per)), per,
      facets: { categories: catalog.categoriesOf(base), price: { lo: prices.length ? Math.min(...prices) : null, hi: prices.length ? Math.max(...prices) : null } } };
  });

  r.get('/api/market/suggest', async ctx => {
    const text = str(ctx.query.q, 40).toLowerCase();
    if (text.length < 2) return { products: [], categories: [] };
    const rows = catalog.live((await catalog.ensure()).rows);
    return { products: rows.filter(p => p.name.toLowerCase().includes(text)).slice(0, 6).map(p => ({ id: p.id, name: p.name })),
      categories: catalog.categoriesOf(rows).filter(c => c.name.toLowerCase().includes(text)).slice(0, 4).map(c => c.name) };
  });

  // wishlist / recently viewed: the browser keeps product ids, this returns live data for them
  r.post('/api/market/products/by-ids', async ctx => {
    const ids = new Set((Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 40));
    if (!ids.size) return [];
    const rows = catalog.live((await catalog.ensure()).rows).filter(p => ids.has(p.id)), ratings = await catalog.ratingMap(), sold = await catalog.soldMap();
    return rows.map(p => catalog.shape(p, ratings, sold));
  });

  r.get('/api/market/products/:id', async ctx => {
    const id = +ctx.params.id, c = await catalog.ensure(), row = c.byId.get(id);
    if (!row || !row.active || row.price == null) throw new HttpError(404, 'This product is not available');
    const ratings = await catalog.ratingMap(), sold = await catalog.soldMap(), product = catalog.shape(row, ratings, sold);
    const dist = Object.fromEntries([1, 2, 3, 4, 5].map(n => [n, 0])); (await q.all('SELECT rating, COUNT(*) n FROM reviews WHERE product_id=? GROUP BY rating', id)).forEach(x => dist[x.rating] = x.n);
    const reviews = (await q.all('SELECT r.id, r.rating, r.title, r.body, r.created_at, u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.id DESC LIMIT 30', id)).map(x => ({ ...x, name: reviewerName(x.name) }));
    const user = await userFromReq(ctx.req); let can_review = false, my_review = null;
    if (user && user.role === 'customer') {
      my_review = await q.get('SELECT id, rating, title, body FROM reviews WHERE product_id=? AND user_id=?', id, user.id) || null;
      can_review = !my_review && !!await q.get(`SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.customer_id=? AND o.status IN ${catalog.PAID}`, id, user.id);
    }
    const pool = catalog.live(c.rows).filter(p => p.id !== id), same = pool.filter(p => row.category && p.category === row.category), rest = pool.filter(p => !(row.category && p.category === row.category));
    const related = [...catalog.sortRows(same, 'popular', sold, ratings), ...catalog.sortRows(rest, 'popular', sold, ratings)].slice(0, 8).map(p => catalog.shape(p, ratings, sold));
    return { product, shop: publicShop(), reviews, rating_breakdown: dist, can_review, my_review, related };
  });

  r.post('/api/market/products/:id/reviews', requireAuth('customer'), async ctx => {
    if (!rateLimit('review:' + ctx.user.id, 10, 3600e3)) throw new HttpError(429, 'Too many reviews. Try again later.');
    const id = +ctx.params.id; if (!(await catalog.ensure()).byId.has(id)) throw new HttpError(404, 'Product not found');
    const bought = await q.get(`SELECT 1 FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=? AND o.customer_id=? AND o.status IN ${catalog.PAID}`, id, ctx.user.id);
    if (!bought) throw new HttpError(403, 'Only customers who bought this product can review it.');
    const rating = Math.trunc(num(ctx.body.rating, { min: 1, max: 5, required: true, name: 'Rating' }));
    try { await q.run('INSERT INTO reviews(product_id,user_id,rating,title,body) VALUES(?,?,?,?,?)', id, ctx.user.id, rating, str(ctx.body.title, 100) || null, str(ctx.body.body, 1500) || null); }
    catch { throw new HttpError(409, 'You have already reviewed this product.'); }
    return { ok: true };
  });

  // Re-price and re-check a cart against the live catalogue. The browser only keeps product ids, quantities and chosen options.
  r.post('/api/market/cart', async ctx => {
    const raw = Array.isArray(ctx.body.items) ? ctx.body.items.slice(0, 60) : [], c = await catalog.ensure(), ratings = await catalog.ratingMap(), sold = await catalog.soldMap(), items = [];
    for (const it of raw) {
      const id = +it.product_id, qty = Math.max(1, Math.min(100, Math.trunc(+it.qty) || 1)), size = str(it.size, 30), colour = str(it.colour, 30), key = id + '|' + size + '|' + colour, row = c.byId.get(id);
      if (!row || !row.active || row.price == null) { items.push({ key, product_id: id, qty, size, colour, variant: [size, colour].filter(Boolean).join(' · ') || null, problem: 'No longer available', line_total: 0 }); continue; }
      const p = catalog.shape(row, ratings, sold); let problem = null, useQty = qty, variant = null;
      try { variant = catalog.variantLabel(row, size, colour); } catch (e) { problem = e.message; }
      if (!p.in_stock) problem = 'Out of stock';
      else if (p.stock_qty != null && qty > p.stock_qty) { useQty = p.stock_qty; problem = `Only ${p.stock_qty} left`; }
      items.push({ key, product: p, qty: useQty, requested_qty: qty, size, colour, variant, problem, line_total: problem && !/^Only \d+ left$/.test(problem) ? 0 : p.price * useQty });
    }
    return { items, subtotal: items.reduce((a, i) => a + (i.line_total || 0), 0), shop: publicShop() };
  });
};
