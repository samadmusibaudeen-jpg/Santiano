'use strict';
// Shopper storefront, part 1: state, header, router, shared components, home, search, product page.
// Uses helpers from core.js (h, $, clear, GET/POST, toast, modal, naira, App). Part 2 is store2.js.
const SF = { routes: [], q: {}, view: null };
const ICONS = [[/shoe|foot|sneak|sandal|boot/i, '👟'], [/cloth|fashion|dress|wear|shirt|ankara/i, '👗'], [/bag|luggage/i, '👜'], [/phone|gadget|mobile/i, '📱'], [/electr|laptop|computer|audio/i, '🔌'], [/beauty|cosmetic|skin|hair|perfume|care/i, '💄'], [/home|kitchen|furnit|living|decor/i, '🛋️'], [/grocer|food|drink/i, '🛒'], [/kid|baby|toy|child/i, '🧸'], [/watch|jewel|access/i, '⌚'], [/sport|fitness|gym/i, '🏋️']];
const catIcon = name => (ICONS.find(([re]) => re.test(name)) || [0, '🛍️'])[1];
const shopInfo = () => (App.meta && App.meta.shop) || {};
const store = (pattern, fn) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); SF.routes.push({ re, keys, fn }); };
const ls = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== '' && v != null && v !== false) p.set(k, v); const s = p.toString(); return s ? '?' + s : ''; };
const link = (path, o) => '#' + path + (o ? qs(o) : '');

// ---------- cart & wishlist (stored in the browser; prices are always re-checked by the server) ----------
const Cart = {
  items: () => ls.get('santiano_cart', []),
  save(a) { ls.set('santiano_cart', a); SF.badges(); },
  same: (i, pid, size, colour) => i.product_id === pid && (i.size || '') === (size || '') && (i.colour || '') === (colour || ''),
  add(pid, qty = 1, size = '', colour = '') { const a = Cart.items(), f = a.find(i => Cart.same(i, pid, size, colour)); if (f) f.qty = Math.min(100, f.qty + qty); else a.push({ product_id: pid, qty, size, colour }); Cart.save(a); },
  setQty(pid, size, colour, qty) { const a = Cart.items(), f = a.find(i => Cart.same(i, pid, size, colour)); if (f) { f.qty = Math.max(1, Math.min(100, qty)); Cart.save(a); } },
  remove(pid, size, colour) { Cart.save(Cart.items().filter(i => !Cart.same(i, pid, size, colour))); },
  removeWhere(fn) { Cart.save(Cart.items().filter(i => !fn(i))); },
  count: () => Cart.items().reduce((a, i) => a + i.qty, 0),
};
const Wish = {
  ids: () => ls.get('santiano_wish', []),
  has: id => Wish.ids().includes(id),
  toggle(id) { const a = Wish.ids(), on = a.includes(id); ls.set('santiano_wish', on ? a.filter(x => x !== id) : [id, ...a].slice(0, 100)); SF.badges(); return !on; },
};
const seen = id => { const a = ls.get('santiano_recent', []).filter(x => x !== id); a.unshift(id); ls.set('santiano_recent', a.slice(0, 12)); };

// ---------- small components ----------
const stars = (avg, count, { hideEmpty } = {}) => {
  if (!count) return hideEmpty ? null : h('span', { class: 'sf-stars' }, h('small', {}, 'No reviews yet'));
  const n = Math.round(avg);
  return h('span', { class: 'sf-stars', 'aria-label': `${avg} out of 5 stars` }, '★'.repeat(n) + '☆'.repeat(5 - n), h('small', {}, `${avg} (${count})`));
};
const priceBlock = (p, big) => h('div', { class: 'sf-price' }, h('b', big ? { class: 'big' } : {}, naira(p.price)), p.compare_at ? h('s', {}, naira(p.compare_at)) : null, p.compare_at ? h('span', { class: 'tag bad' }, `-${p.discount_pct}%`) : null);
function wishBtn(p) {
  const b = h('button', { class: 'sf-wish' + (Wish.has(p.id) ? ' on' : ''), 'aria-label': 'Save to wishlist', 'aria-pressed': Wish.has(p.id), title: 'Save for later',
    onclick: e => { e.preventDefault(); e.stopPropagation(); const on = Wish.toggle(p.id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.textContent = on ? '♥' : '♡'; } }, Wish.has(p.id) ? '♥' : '♡');
  return b;
}
function productCard(p) {
  const simple = !p.sizes.length && !p.colours.length;
  return h('div', { class: 'sf-card' },
    h('a', { class: 'im', href: link('/p/' + p.id), 'aria-label': p.name }, h('img', { src: p.image, alt: p.name, loading: 'lazy' }), p.compare_at ? h('span', { class: 'sf-off' }, `-${p.discount_pct}%`) : null, !p.in_stock ? h('div', { class: 'sf-oos' }, 'Out of stock') : null),
    wishBtn(p),
    h('div', { class: 'bd' }, h('a', { class: 'nm', href: link('/p/' + p.id) }, p.name), priceBlock(p), stars(p.rating_avg, p.rating_count, { hideEmpty: true }),
      p.in_stock ? (simple ? h('button', { class: 'btn sm add', onclick: e => { Cart.add(p.id, 1); toast(`${p.name} added to cart`); } }, 'Add to cart') : h('a', { class: 'btn sm sec add', href: link('/p/' + p.id) }, 'Choose options')) : null));
}
const grid = items => h('div', { class: 'sf-grid' }, items.map(productCard));
const section = (title, content, moreHref, moreLabel = 'See all') => h('section', { class: 'sf-sec' }, h('div', { class: 'hd' }, h('h2', {}, title), moreHref ? h('a', { href: moreHref }, moreLabel + ' →') : null), content);
const emptyState = (title, text, cta) => h('div', { class: 'card empty' }, h('h2', {}, title), h('p', {}, text), cta || null);
const skeleton = () => h('div', { class: 'sf-grid' }, Array.from({ length: 8 }, () => h('div', { class: 'sf-skel' })));

// ---------- layout ----------
function drawHeader() {
  const u = App.user, input = h('input', { type: 'search', placeholder: 'Search for products', 'aria-label': 'Search', autocomplete: 'off', value: SF.q.q || '' }), box = h('div', { class: 'sf-sugg', hidden: true });
  let timer; const closeBox = () => { box.hidden = true; };
  input.addEventListener('input', () => { clearTimeout(timer); const v = input.value.trim(); if (v.length < 2) return closeBox();
    timer = setTimeout(async () => { try { const r = await GET('/api/market/suggest?q=' + encodeURIComponent(v), { quiet: true }); clear(box);
      r.categories.forEach(c => box.append(h('a', { href: link('/search', { category: c }) }, c, h('small', {}, 'in category'))));
      r.products.forEach(p => box.append(h('a', { href: link('/p/' + p.id) }, p.name)));
      box.hidden = !box.children.length; } catch {} }, 180); });
  document.addEventListener('click', e => { if (!box.parentNode || !box.parentNode.contains(e.target)) closeBox(); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') closeBox(); });
  const form = h('form', { role: 'search', onsubmit: e => { e.preventDefault(); closeBox(); location.hash = link('/search', { q: input.value.trim() }); } }, input, h('button', { type: 'submit', 'aria-label': 'Search' }, 'Search'));
  SF.searchInput = input; SF.closeSugg = closeBox;
  const sh = shopInfo();
  const nav = h('nav', { class: 'sf-nav', 'aria-label': 'Account' },
    u && u.role === 'admin' ? h('a', { href: '/admin.html' }, '🛠️', h('span', { class: 'lbl' }, ' Admin')) : null,
    u ? h('a', { href: u.role === 'customer' ? link('/account') : homeFor(u) }, '👤', h('span', { class: 'lbl' }, ' ' + u.name.split(' ')[0])) : h('a', { href: '/login.html', onclick: () => sessionStorage.setItem('after_login', location.pathname + location.hash) }, '👤', h('span', { class: 'lbl' }, ' Sign in')),
    h('a', { href: link('/wishlist'), 'aria-label': 'Wishlist' }, '♡', h('span', { class: 'cnt', id: 'wish-cnt', hidden: true })),
    h('a', { href: link('/cart'), 'aria-label': 'Cart' }, '🛒', h('span', { class: 'cnt', id: 'cart-cnt', hidden: true }), h('span', { class: 'lbl' }, ' Cart')));
  const deps = h('div', { class: 'sf-deps' }, h('div', {}, h('a', { href: link('/search', { deals: 1 }) }, '🔥 Deals'), (App.meta.categories || []).slice(0, 14).map(c => h('a', { href: link('/search', { category: c.name }) }, c.name)), h('a', { href: link('/search') }, 'All products')));
  const promo = h('div', { class: 'sf-promo' }, [sh.free_delivery_over ? `🚚 Free delivery on orders over ${naira(sh.free_delivery_over)}` : '🚚 Delivered to your door', '🔒 Secure payment with Paystack', sh.returns_policy ? '↩️ Easy returns' : null].filter(Boolean).map(t => h('span', {}, t)));
  return h('header', { class: 'sf-head' }, promo, h('div', { class: 'sf-top' }, h('a', { class: 'brand', href: '#/' }, h('i', {}, (sh.name || 'S')[0]), sh.name || 'Santiano'), h('div', { class: 'sf-search' }, form, box), nav), deps);
}
SF.badges = () => {
  const c = $('#cart-cnt'), w = $('#wish-cnt'), n = Cart.count(), k = Wish.ids().length;
  if (c) { c.textContent = n; c.hidden = !n; } if (w) { w.textContent = k; w.hidden = !k; }
};
const drawFooter = () => { const sh = shopInfo(), wa = sh.whatsapp ? 'https://wa.me/' + String(sh.whatsapp).replace(/\D/g, '').replace(/^0/, '234') : null;
  return h('footer', { class: 'sf-foot' }, h('div', { class: 'in' },
    h('div', {}, h('h4', {}, sh.name || 'Santiano'), h('p', {}, 'Quality products delivered to your door. Pay securely with card, bank transfer or USSD.')),
    h('div', {}, h('h4', {}, 'Shop'), h('a', { href: link('/search', { deals: 1 }) }, 'Deals'), h('a', { href: link('/search') }, 'All products'), (App.meta.categories || []).slice(0, 4).map(c => h('a', { href: link('/search', { category: c.name }) }, c.name))),
    h('div', {}, h('h4', {}, 'Your account'), h('a', { href: link('/orders') }, 'My orders'), h('a', { href: link('/wishlist') }, 'Wishlist'), h('a', { href: link('/account') }, 'Contact support')),
    h('div', {}, h('h4', {}, 'Help'), sh.phone ? h('a', { href: 'tel:' + sh.phone }, 'Call ' + sh.phone) : null, wa ? h('a', { href: wa, target: '_blank', rel: 'noopener' }, 'WhatsApp us') : null, sh.returns_policy ? h('p', { class: 'sm' }, sh.returns_policy) : null, h('p', { class: 'sm' }, 'Payments are processed by Paystack. Card details never reach us.')))); };

// ---------- router ----------
async function go() {
  const hash = location.hash.replace(/^#/, '') || '/', [pathPart, query] = hash.split('?');
  SF.q = Object.fromEntries(new URLSearchParams(query || '')); if (SF.closeSugg) SF.closeSugg();
  if (SF.searchInput && document.activeElement !== SF.searchInput) SF.searchInput.value = pathPart === '/search' ? (SF.q.q || '') : '';
  document.querySelectorAll('.sf-deps a').forEach(a => a.classList.toggle('on', pathPart === '/search' && a.getAttribute('href') === '#' + hash));
  for (const r of SF.routes) {
    const m = r.re.exec(pathPart); if (!m) continue;
    const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
    clear(SF.view).append(h('div', { class: 'sf-skel' })); window.scrollTo(0, 0);
    try { const out = await r.fn(params); clear(SF.view); if (out) SF.view.append(out); } catch (e) { console.error(e); clear(SF.view).append(emptyState(e.status === 404 ? 'We could not find that' : 'Something went wrong', e.message, h('a', { class: 'btn', href: '#/' }, 'Back to the marketplace'))); }
    return;
  }
  clear(SF.view).append(emptyState('Page not found', 'That page does not exist.', h('a', { class: 'btn', href: '#/' }, 'Go home')));
}
const needLogin = () => { if (App.user && App.user.role === 'customer') return false; sessionStorage.setItem('after_login', location.pathname + location.hash); location.href = '/login.html'; return true; };

// ---------- home ----------
// Hero: glow background, search box with typewriter placeholder, and a phone mockup whose sample order-tracking chat loops (an illustration).
function heroSection(d) {
  const prods = [...d.best_sellers, ...d.new_arrivals].filter((p, i, a) => a.findIndex(x => x.id === p.id) === i), sh = d.shop || {};
  const ask = h('input', { type: 'search', 'aria-label': 'Search products', autocomplete: 'off', placeholder: 'Search for anything…' });
  const askForm = h('form', { class: 'ask', role: 'search', onsubmit: e => { e.preventDefault(); location.hash = link('/search', { q: ask.value.trim() }); } }, ask, h('button', { type: 'submit', 'aria-label': 'Search' }, '↑'));
  const phrases = prods.slice(0, 5).map(p => p.name).filter(n => n && n.length < 38);
  SFX.typePlaceholder(ask, phrases.length >= 2 ? phrases : ['Search for anything…']);
  const steps = [{ t: 'ai', text: '✅ Payment received. Thank you!' }, { t: 'card', title: 'Order SO1042 · 2 items', big: prods[0] ? naira(prods[0].price + (prods[1] ? prods[1].price : 0)) : '₦18,500', sub: 'Paid securely with Paystack', row: 'Paid' }, { t: 'typing', ms: 900 }, { t: 'ai', text: '📦 We are packing your order now.' }, { t: 'typing', ms: 900 }, { t: 'ai', text: '🚚 Your order is on the way!' }];
  const body = h('div', { class: 'ph-body' }); SFX.phone(body, steps);
  return h('section', { class: 'hero-g' }, h('div', { class: 'in' },
    h('div', {}, h('span', { class: 'eyebrow' }, sh.free_delivery_over ? `Free delivery over ${naira(sh.free_delivery_over)}` : 'Fast delivery to your door'),
      h('h1', {}, 'Everything you need, ', h('em', {}, 'delivered'), '.'),
      h('p', { class: 'lead' }, 'Fashion, gadgets, home and more at great prices. Pay securely with Paystack and track every order.'),
      askForm,
      h('div', { class: 'row' }, h('a', { class: 'btn', href: link('/search') }, 'Shop now'), h('a', { class: 'btn sec', href: link('/search', { deals: 1 }) }, '🔥 Today\'s deals')),
      d.totals.products ? h('div', { class: 'stats' }, h('div', {}, h('b', {}, d.totals.products), h('span', {}, 'products')), h('div', {}, h('b', {}, d.categories.length), h('span', {}, 'categories'))) : null),
    h('div', { class: 'phone-wrap', 'aria-hidden': 'true' },
      h('div', { class: 'fchip a' }, 'Paid via Paystack'), h('div', { class: 'fchip b' }, 'Track every order'),
      h('div', { class: 'phone' },
        h('div', { class: 'ph-head' }, h('div', { class: 'ph-av' }, (sh.name || 'S')[0]), h('div', {}, h('b', {}, sh.name || 'Santiano'), h('small', {}, 'Order updates'))),
        body,
        h('div', { class: 'ph-input' }, h('span', {}, 'Message…'), h('i', {}, '↑'))),
      h('div', { class: 'phone-note' }, 'Illustration · sample order'))));
}
const trustStrip = sh => h('div', { class: 'trust' }, [['🚚', 'Delivery to your door', sh.free_delivery_over ? `Free over ${naira(sh.free_delivery_over)}` : (sh.delivery_fee ? 'Flat ' + naira(sh.delivery_fee) : 'Free delivery')], ['🔒', 'Secure payment', 'Card, transfer or USSD via Paystack'], ['↩️', 'Easy returns', sh.returns_policy ? 'See our returns policy' : 'We have got you covered'], ['💬', 'Real support', 'We reply to every message']].map(([i, t, s]) => h('div', {}, h('span', { class: 'ti' }, i), h('div', {}, h('b', {}, t), h('small', {}, s)))));
store('/', async () => {
  const d = await GET('/api/market/home'), page = h('div', {});
  document.title = (d.shop.name || 'Santiano') + ' · Shop online';
  page.append(heroSection(d));
  if (d.categories.length) page.append(h('div', { class: 'marq', 'aria-hidden': 'true' }, h('div', { class: 'track' }, [0, 1].flatMap(() => d.categories.map(x => h('a', { href: link('/search', { category: x.name }), tabindex: '-1' }, catIcon(x.name) + ' ' + x.name))))));
  page.append(trustStrip(d.shop));
  if (d.categories.length) page.append(section('Shop by category', h('div', { class: 'sf-deptgrid' }, d.categories.map(x => h('a', { class: 'sf-dept', href: link('/search', { category: x.name }) }, h('span', { class: 'ic' }, catIcon(x.name)), h('b', {}, x.name), h('span', {}, `${x.count} item${x.count === 1 ? '' : 's'}`))))));
  if (d.deals.length) page.append(section('🔥 Deals', h('div', { class: 'sf-row' }, d.deals.map(productCard)), link('/search', { deals: 1 })));
  if (d.best_sellers.length) page.append(section('Best sellers', h('div', { class: 'sf-row' }, d.best_sellers.map(productCard)), link('/search', { sort: 'popular' })));
  if (d.new_arrivals.length) page.append(section('New arrivals', h('div', { class: 'sf-row' }, d.new_arrivals.map(productCard)), link('/search', { sort: 'new' })));
  const recent = ls.get('santiano_recent', []).slice(0, 8);
  if (recent.length) { const box = h('div', {}); page.append(section('Recently viewed', box)); POST('/api/market/products/by-ids', { ids: recent }, { quiet: true }).then(items => { if (!items.length) return box.parentNode.remove(); const order = new Map(recent.map((id, i) => [id, i])); items.sort((a, b) => order.get(a.id) - order.get(b.id)); box.append(h('div', { class: 'sf-row' }, items.map(productCard))); }).catch(() => {}); }
  if (!d.totals.products) page.append(emptyState('We are stocking the shelves', 'New products are being added. Please check back soon.'));
  return page;
});

// ---------- search / browse ----------
const SORTS = [['popular', 'Best selling'], ['new', 'Newest'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['rating', 'Top rated']];
store('/search', async () => {
  const Q = { ...SF.q }, page = +Q.page || 1, d = await GET('/api/market/products' + qs({ ...Q, page, per: 24 }));
  const setQ = (changes) => { const n = { ...Q, ...changes }; if (!('page' in changes)) delete n.page; for (const k of Object.keys(n)) if (n[k] === '' || n[k] == null || n[k] === false) delete n[k]; return link('/search', n); };
  const opt = (label, count, href, on) => h('a', { class: 'opt' + (on ? ' on' : ''), href }, h('span', { style: 'color:inherit;font-size:inherit' }, label), h('span', {}, count));
  const min = h('input', { type: 'number', min: 0, placeholder: 'Min', value: Q.min || '', 'aria-label': 'Minimum price' }), max = h('input', { type: 'number', min: 0, placeholder: 'Max', value: Q.max || '', 'aria-label': 'Maximum price' });
  const filters = h('details', { class: 'sf-filters' }, h('summary', {}, 'Filters'),
    d.facets.categories.length ? [h('h4', {}, 'Category'), opt('All categories', '', setQ({ category: '' }), !Q.category), d.facets.categories.map(x => opt(x.name, x.count, setQ({ category: x.name }), Q.category === x.name))] : null,
    h('h4', {}, 'Price (₦)'), h('form', { class: 'pr', onsubmit: e => { e.preventDefault(); location.hash = setQ({ min: min.value, max: max.value }); } }, min, '–', max, h('button', { class: 'btn sm', type: 'submit' }, 'Go')),
    h('h4', {}, 'Availability'), opt('In stock only', '', setQ({ in_stock: Q.in_stock === '1' ? '' : 1 }), Q.in_stock === '1'), opt('On sale', '', setQ({ deals: Q.deals === '1' ? '' : 1 }), Q.deals === '1'));
  if (window.matchMedia('(min-width:821px)').matches) filters.open = true;
  const chips = [Q.q && ['“' + Q.q + '”', { q: '' }], Q.category && [Q.category, { category: '' }], Q.min && ['From ' + naira(Q.min), { min: '' }], Q.max && ['Up to ' + naira(Q.max), { max: '' }], Q.in_stock && ['In stock', { in_stock: '' }], Q.deals && ['On sale', { deals: '' }]]
    .filter(Boolean).map(([t, c]) => h('span', { class: 'sf-chip' }, t, ' ', h('a', { href: setQ(c), 'aria-label': 'Remove filter ' + t }, '×')));
  const sort = h('select', { 'aria-label': 'Sort by', onchange: () => { location.hash = setQ({ sort: sort.value }); } }, SORTS.map(([k, l]) => h('option', { value: k, selected: (Q.sort || 'popular') === k }, l)));
  const pager = d.pages > 1 ? h('nav', { class: 'sf-pager', 'aria-label': 'Pages' }, page > 1 ? h('a', { href: setQ({ page: page - 1 }) }, '← Prev') : null,
    Array.from({ length: d.pages }, (_, i) => i + 1).filter(n => n === 1 || n === d.pages || Math.abs(n - page) <= 2).map((n, i, a) => [i && n - a[i - 1] > 1 ? h('span', {}, '…') : null, n === page ? h('span', { class: 'on', 'aria-current': 'page' }, n) : h('a', { href: setQ({ page: n }) }, n)]),
    page < d.pages ? h('a', { href: setQ({ page: page + 1 }) }, 'Next →') : null) : null;
  const title = Q.q ? `Results for “${Q.q}”` : Q.deals ? 'Deals' : Q.category || 'All products';
  document.title = title + ' · ' + (shopInfo().name || 'Santiano');
  return h('div', { class: 'sf-find' }, filters, h('div', {}, h('div', { class: 'sf-bar' }, h('div', {}, h('h1', { style: 'margin:0' }, title), h('span', { class: 'muted' }, `${d.total} item${d.total === 1 ? '' : 's'}`)), sort), chips.length ? h('div', {}, chips) : null,
    d.items.length ? [grid(d.items), pager] : emptyState('No products match', Q.q ? 'Check the spelling, try fewer words, or remove some filters.' : 'Try removing some filters.', h('a', { class: 'btn', href: link('/search') }, 'Clear all filters'))));
});

// ---------- product page ----------
store('/p/:id', async ({ id }) => {
  const d = await GET('/api/market/products/' + id), p = d.product, s = d.shop;
  document.title = p.name + ' · ' + (s.name || 'Santiano'); seen(p.id);
  let size = p.sizes.length === 1 ? p.sizes[0] : '', colour = p.colours.length === 1 ? p.colours[0] : '', qty = 1;
  const imgs = p.images.length ? p.images : [p.image], mainImg = h('img', { src: imgs[0], alt: p.name });
  const thumbs = imgs.length > 1 ? h('div', { class: 'th' }, imgs.map((u, i) => h('button', { class: i ? '' : 'on', 'aria-label': 'Photo ' + (i + 1), onclick: e => { mainImg.src = u; thumbs.querySelectorAll('button').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, h('img', { src: u, alt: '' })))) : null;
  const picker = (label, list, get, set) => { if (!list.length) return null; const row = h('div', { class: 'sf-opts', role: 'radiogroup', 'aria-label': label });
    const draw = () => { clear(row); list.forEach(v => row.append(h('button', { type: 'button', role: 'radio', 'aria-checked': get() === v, class: get() === v ? 'on' : '', onclick: () => { set(v); draw(); err.textContent = ''; } }, v))); }; draw();
    return h('div', {}, h('label', {}, label, get() ? h('span', { class: 'hint' }, ' ' + get()) : null), row); };
  const err = h('div', { class: 'err', role: 'alert' }), qtyEl = h('span', {}, '1'), max = p.stock_qty != null ? p.stock_qty : 100;
  const stepper = h('div', { class: 'sf-qty' }, h('button', { type: 'button', 'aria-label': 'Fewer', onclick: () => { qty = Math.max(1, qty - 1); qtyEl.textContent = qty; } }, '−'), qtyEl, h('button', { type: 'button', 'aria-label': 'More', onclick: () => { qty = Math.min(max, qty + 1); qtyEl.textContent = qty; } }, '+'));
  const check = () => { if (p.sizes.length && !size) { err.textContent = 'Please choose a size.'; return false; } if (p.colours.length && !colour) { err.textContent = 'Please choose a colour.'; return false; } return true; };
  const stock = !p.in_stock ? h('span', { class: 'tag bad' }, 'Out of stock') : p.stock_qty != null && p.stock_qty <= 5 ? h('span', { class: 'tag warn' }, `Only ${p.stock_qty} left`) : h('span', { class: 'tag' }, 'In stock');
  const freeLine = s.free_delivery_over ? ` Free delivery on orders of ${naira(s.free_delivery_over)} or more.` : '';
  const wa = s.whatsapp ? 'https://wa.me/' + String(s.whatsapp).replace(/\D/g, '').replace(/^0/, '234') + '?text=' + encodeURIComponent('Hi, I have a question about: ' + p.name) : null;
  const info = h('div', { class: 'sf-info' }, h('div', { class: 'sf-crumb' }, h('a', { href: '#/' }, 'Home'), p.category ? [' / ', h('a', { href: link('/search', { category: p.category }) }, p.category)] : null),
    h('h1', {}, p.name), h('div', { class: 'row' }, stars(p.rating_avg, p.rating_count), p.sold ? h('span', { class: 'muted sm' }, `${p.sold} sold`) : null), h('div', { style: 'margin:.5rem 0' }, priceBlock(p, true)), h('div', { style: 'margin-bottom:.6rem' }, stock, ' '),
    picker('Size', p.sizes, () => size, v => size = v), picker('Colour', p.colours, () => colour, v => colour = v),
    p.in_stock ? h('div', { class: 'row', style: 'margin:.6rem 0' }, stepper, h('button', { class: 'btn', onclick: () => { if (!check()) return; Cart.add(p.id, qty, size, colour); toast('Added to cart'); } }, 'Add to cart'),
      h('button', { class: 'btn sec', onclick: () => { if (!check()) return; Cart.add(p.id, qty, size, colour); location.hash = link('/cart'); } }, 'Buy now'), (() => { const w = wishBtn(p); w.style.position = 'static'; w.style.border = '1.5px solid var(--line)'; return w; })()) : h('p', { class: 'muted' }, 'This item is currently unavailable. Save it to your wishlist and check back later.'),
    err,
    h('div', { class: 'sf-box' }, h('b', {}, 'Delivery & returns'), h('div', {}, `Delivery: ${s.delivery_fee ? naira(s.delivery_fee) : 'free'}.${freeLine}` + (s.offers_pickup ? ' Pickup available.' : '')), s.pickup_info && s.offers_pickup ? h('div', { class: 'muted' }, s.pickup_info) : null, s.returns_policy ? h('div', { class: 'muted' }, s.returns_policy) : null,
      s.payments_enabled ? h('div', { class: 'muted' }, 'Secure checkout with Paystack.') : h('div', { class: 'err' }, 'Online payments are not switched on yet.'), wa ? h('div', { style: 'margin-top:.4rem' }, h('a', { class: 'btn sec sm', target: '_blank', rel: 'noopener', href: wa }, '💬 Ask about this item')) : null),
    p.description ? [h('h3', {}, 'About this item'), h('p', { style: 'white-space:pre-wrap' }, p.description)] : null, p.specs ? [h('h3', {}, 'Details'), h('p', { style: 'white-space:pre-wrap' }, p.specs)] : null);
  const page = h('div', {}, h('div', { class: 'sf-pdp' }, h('div', { class: 'sf-gal' }, h('div', { class: 'main' }, mainImg), thumbs), info));

  // reviews
  const bd = d.rating_breakdown, total = p.rating_count || 0, revBox = h('section', { class: 'sf-sec sf-rev', id: 'reviews' }, h('h2', {}, 'Customer reviews'));
  revBox.append(total ? h('div', { class: 'sum' }, h('div', {}, h('div', { class: 'big' }, p.rating_avg), stars(p.rating_avg, total)), h('div', { class: 'sf-bars' }, [5, 4, 3, 2, 1].map(n => h('div', { class: 'r' }, `${n} ★`, h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((bd[n] || 0) / total * 100)}%` })), bd[n] || 0)))) : h('p', { class: 'muted' }, 'No reviews yet. Only customers who bought this item can review it.'));
  if (d.can_review) {
    let rate = 0; const rb = h('div', { class: 'sf-rate', role: 'radiogroup', 'aria-label': 'Your rating' }), title = h('input', { type: 'text', maxlength: 100, placeholder: 'Headline (optional)' }), body = h('textarea', { maxlength: 1500, placeholder: 'What did you like or dislike?' });
    const drawRate = () => { clear(rb); [1, 2, 3, 4, 5].forEach(n => rb.append(h('button', { type: 'button', class: n <= rate ? 'on' : '', 'aria-label': n + ' star' + (n > 1 ? 's' : ''), onclick: () => { rate = n; drawRate(); } }, '★'))); }; drawRate();
    revBox.append(h('div', { class: 'card', style: 'margin:1rem 0' }, h('h3', {}, 'Write a review'), rb, field('Headline', title), field('Review', body), h('button', { class: 'btn', style: 'margin-top:.6rem', onclick: onClick(async () => { if (!rate) throw new Error('Choose a star rating'); await POST(`/api/market/products/${p.id}/reviews`, { rating: rate, title: title.value, body: body.value }); toast('Thanks for your review!'); go(); }) }, 'Submit review')));
  } else if (d.my_review) revBox.append(h('p', { class: 'tag' }, 'You reviewed this product'));
  d.reviews.forEach(r => revBox.append(h('div', { class: 'one' }, h('div', { class: 'row' }, h('span', { class: 'sf-stars' }, '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)), h('b', {}, r.title || ''), ), h('div', { class: 'muted sm' }, `${r.name} · ${ago(r.created_at)} · Verified purchase`), r.body ? h('p', { style: 'margin:.3rem 0 0;white-space:pre-wrap' }, r.body) : null)));
  page.append(revBox);
  if (d.related.length) page.append(section('You may also like', h('div', { class: 'sf-row' }, d.related.map(productCard))));
  return page;
});
