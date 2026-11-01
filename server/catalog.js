// The product catalogue. Source of truth: the `products` table in Supabase. Rows are cached in memory
// (refreshed every few seconds) so browsing and search are instant and the shop keeps working through a short Supabase blip.
const supa = require('./supa');
const { q } = require('./db');
const { HttpError } = require('./http');

const TTL_MS = 15000;
const PAID = "('paid','processing','ready','dispatched','completed')";
const naira = n => n == null || n === '' ? null : '₦' + Math.round(+n).toLocaleString('en-NG');

// Supabase columns can be real arrays (text[]) or, if someone typed into the table editor, comma-separated text. Accept both.
const arr = v => (Array.isArray(v) ? v : typeof v === 'string' ? (v.trim().startsWith('[') ? (() => { try { return JSON.parse(v); } catch { return []; } })() : v.split(',')) : []).map(x => String(x).trim()).filter(Boolean);
const numOrNull = v => v === null || v === undefined || v === '' ? null : Number.isFinite(+v) ? +v : null;
function norm(r) {
  return { id: Number(r.id), name: String(r.name || ''), description: r.description || '', category: (r.category || '').trim(), price: numOrNull(r.price), compare_at: numOrNull(r.compare_at),
    stock_qty: numOrNull(r.stock_qty) == null ? null : Math.trunc(r.stock_qty), sizes: arr(r.sizes), colours: arr(r.colours), images: arr(r.images), specs: r.specs || '', tags: r.tags || '',
    active: r.active !== false && r.active !== 'false', created_at: r.created_at || null, updated_at: r.updated_at || null };
}

let cache = { at: 0, rows: [], byId: new Map(), loading: null, error: null, loaded: false };
async function fetchAll() {
  const rows = [];
  for (let off = 0; off < 20000; off += 1000) {
    const page = await supa.rest('GET', `products?select=*&order=id.desc&limit=1000&offset=${off}`);
    rows.push(...page); if (page.length < 1000) break;
  }
  return rows.map(norm);
}
function load(force) {
  if (cache.loading) return cache.loading;
  cache.loading = fetchAll().then(rows => { cache = { ...cache, at: Date.now(), rows, byId: new Map(rows.map(r => [r.id, r])), error: null, loaded: true, loading: null }; })
    .catch(e => { cache.loading = null; cache.error = e.message; if (!cache.loaded) throw e; });
  return cache.loading;
}
// Returns cached rows; refreshes in the background when stale (and waits only on the very first load).
async function ensure() {
  if (!supa.configured()) throw new HttpError(503, 'Supabase is not connected yet.');
  if (!cache.loaded) await load();
  else if (Date.now() - cache.at > TTL_MS) load().catch(() => {});
  return cache;
}
const status = () => ({ configured: supa.configured(), loaded: cache.loaded, count: cache.rows.length, error: cache.error, last_refresh: cache.at ? new Date(cache.at).toISOString() : null });

// ---------- shaping ----------
const ratingMap = () => new Map(q.all('SELECT product_id id, ROUND(AVG(rating),1) avg, COUNT(*) n FROM reviews GROUP BY product_id').map(r => [r.id, r]));
const soldMap = () => new Map(q.all(`SELECT oi.product_id id, SUM(oi.qty) n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status IN ${PAID} GROUP BY oi.product_id`).map(r => [r.id, r.n]));
const placeholder = id => `/api/placeholder/${id}.svg`;
const inStock = p => p.active && p.price != null && (p.stock_qty == null || p.stock_qty > 0);
function shape(p, ratings = ratingMap(), sold = soldMap()) {
  const compare = p.compare_at != null && p.price != null && p.compare_at > p.price ? p.compare_at : null, rt = ratings.get(p.id);
  return { id: p.id, name: p.name, description: p.description, category: p.category, tags: p.tags, price: p.price, price_label: naira(p.price), compare_at: compare,
    discount_pct: compare ? Math.round((1 - p.price / compare) * 100) : 0, sizes: p.sizes, colours: p.colours, specs: p.specs, stock_qty: p.stock_qty, in_stock: inStock(p),
    images: p.images, image: p.images[0] || placeholder(p.id), created_at: p.created_at, rating_avg: rt ? rt.avg : null, rating_count: rt ? rt.n : 0, sold: sold.get(p.id) || 0 };
}
// For the admin: includes inactive items and raw stock.
const shapeAdmin = (p, sold) => ({ ...shape(p, ratingMap(), sold || soldMap()), active: p.active, updated_at: p.updated_at });

// ---------- shopper queries (in memory) ----------
const live = rows => rows.filter(p => p.active && p.price != null);
function filterRows(rows, Q) {
  const tokens = String(Q.q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6), min = Q.min !== undefined && Q.min !== '' ? +Q.min : null, max = Q.max !== undefined && Q.max !== '' ? +Q.max : null;
  return rows.filter(p => {
    if (Q.category && p.category !== Q.category) return false;
    if (min != null && Number.isFinite(min) && p.price < min) return false;
    if (max != null && Number.isFinite(max) && p.price > max) return false;
    if (Q.in_stock === '1' && !inStock(p)) return false;
    if (Q.deals === '1' && !(p.compare_at != null && p.compare_at > p.price)) return false;
    if (tokens.length) { const hay = (p.name + ' ' + p.description + ' ' + p.tags + ' ' + p.category).toLowerCase(); if (!tokens.every(t => hay.includes(t))) return false; }
    return true;
  });
}
const SORTS = {
  new: () => (a, b) => b.id - a.id,
  price_asc: () => (a, b) => a.price - b.price || b.id - a.id,
  price_desc: () => (a, b) => b.price - a.price || b.id - a.id,
  popular: (s) => (a, b) => (s.get(b.id) || 0) - (s.get(a.id) || 0) || b.id - a.id,
  rating: (s, r) => (a, b) => ((r.get(b.id)?.avg || 0) - (r.get(a.id)?.avg || 0)) || ((r.get(b.id)?.n || 0) - (r.get(a.id)?.n || 0)) || b.id - a.id,
};
function sortRows(rows, key, sold, ratings) { return [...rows].sort((SORTS[key] || SORTS.popular)(sold, ratings)); }
const categoriesOf = rows => { const m = new Map(); for (const p of rows) if (p.category) m.set(p.category, (m.get(p.category) || 0) + 1); return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)); };

// ---------- writes (admin) ----------
const toRow = d => { const r = { ...d }; if ('stock_qty' in r && r.stock_qty == null) r.stock_qty = null; return r; };
async function create(data) { const [row] = await supa.rest('POST', 'products', toRow(data), 'return=representation'); await load(); return norm(row); }
async function update(id, data) { const rows = await supa.rest('PATCH', `products?id=eq.${+id}`, { ...toRow(data), updated_at: new Date().toISOString() }, 'return=representation'); if (!rows || !rows.length) throw new HttpError(404, 'Product not found'); await load(); return norm(rows[0]); }
async function remove(id) { await supa.rest('DELETE', `products?id=eq.${+id}`); await load(); }
// Atomic stock change through the adjust_stock SQL function (see sql/supabase.sql). Returns the new quantity (null when stock is not tracked).
async function adjustStock(id, delta) { const n = await supa.rest('POST', 'rpc/adjust_stock', { p_id: +id, delta: Math.trunc(delta) }); load().catch(() => {}); return n; }
// Fresh rows straight from Supabase (used at checkout so stock checks are never stale).
async function fetchFresh(ids) {
  ids = [...new Set(ids.map(Number).filter(Number.isInteger))]; if (!ids.length) return new Map();
  const rows = (await supa.rest('GET', `products?select=*&id=in.(${ids.join(',')})`)).map(norm); return new Map(rows.map(r => [r.id, r]));
}

// Turn the shopper's chosen size/colour into a label like "42 · Black". Throws a plain message if a required option is missing or unknown.
function variantLabel(p, size, colour) {
  const out = []; size = size ? String(size).trim() : ''; colour = colour ? String(colour).trim() : '';
  if (p.sizes.length) { if (!size) throw new Error(`Choose a size for ${p.name}`); if (!p.sizes.includes(size)) throw new Error(`Size ${size} is not offered for ${p.name}`); out.push(size); }
  if (p.colours.length) { if (!colour) throw new Error(`Choose a colour for ${p.name}`); if (!p.colours.includes(colour)) throw new Error(`${colour} is not offered for ${p.name}`); out.push(colour); }
  return out.join(' · ') || null;
}
module.exports = { ensure, load, status, shape, shapeAdmin, live, filterRows, sortRows, categoriesOf, ratingMap, soldMap, create, update, remove, adjustStock, fetchFresh, variantLabel, inStock, naira, norm, PAID, _reset: () => { cache = { at: 0, rows: [], byId: new Map(), loading: null, error: null, loaded: false }; } };
