'use strict';
// Admin: products (stored in Supabase), photo upload, orders, customers, discount codes, settings, support.
const ADM = ['admin'];
function adminLayout(root, content) {
  const items = [{ group: 'Shop' }, { href: '#/admin', label: '📊 Overview' }, { href: '#/admin/products', label: '📦 Products' }, { href: '#/admin/orders', label: '🧾 Orders' }, { href: '#/admin/customers', label: '👥 Customers' }, { href: '#/admin/support', label: '🛟 Support' },
    { group: 'Money' }, { href: '#/admin/accounts', label: '📒 Accounts' },
    { group: 'Setup' }, { href: '#/admin/discounts', label: '🏷️ Discount codes' }, { href: '#/admin/settings', label: '⚙️ Settings' }, { href: '#/admin/audit', label: '📜 Activity log' }];
  clear(root).append(layoutSide(items, content, 'Admin menu'));
}
const table = (heads, rows) => h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map(x => h('th', {}, x)))), h('tbody', {}, rows)));
const thumb = (src, size = 44) => h('img', { src, alt: '', style: `width:${size}px;height:${size}px;object-fit:cover;border-radius:8px;background:var(--gl);display:block` });
const ORDER_STATUS = { paid: ['Paid', 'blue'], processing: ['Preparing', 'blue'], ready: ['Ready for pickup', 'blue'], dispatched: ['On the way', 'blue'], completed: ['Completed', ''], refunded: ['Refunded', 'grey'], cancelled: ['Cancelled', 'grey'], pending_payment: ['Awaiting payment', 'warn'] };
const statusTag = s => h('span', { class: 'tag ' + (ORDER_STATUS[s] ? ORDER_STATUS[s][1] : 'grey') }, ORDER_STATUS[s] ? ORDER_STATUS[s][0] : s);

// ---------- overview ----------
route('/admin', async (p, root) => {
  const s = await GET('/api/admin/stats'); const st = (n, l) => h('div', { class: 'card stat', style: 'margin:0' }, h('b', {}, n), h('span', {}, l));
  const sb = s.supabase, row = (k, v) => h('div', { class: 'row between sm', style: 'padding:.2rem 0' }, k, h('b', {}, v));
  const setup = !sb.configured ? h('div', { class: 'banner bad' }, h('b', {}, 'Connect Supabase to start adding products.'), h('ol', { style: 'margin:.4rem 0 0 1.1rem;padding:0' },
    h('li', {}, 'Create a project at supabase.com.'), h('li', {}, 'Open SQL Editor, paste the contents of ', h('code', {}, 'sql/supabase.sql'), ' and run it.'), h('li', {}, 'Settings → API: copy the project URL and the ', h('b', {}, 'service_role'), ' key.'),
    h('li', {}, 'Set ', h('code', {}, 'SUPABASE_URL'), ' and ', h('code', {}, 'SUPABASE_SERVICE_ROLE_KEY'), ' where the shop runs, then restart it.')))
    : sb.error ? h('div', { class: 'banner bad' }, h('b', {}, 'Supabase problem: '), sb.error) : null;
  adminLayout(root, h('div', {}, h('h1', {}, 'Overview'), setup,
    s.system.demo_payments ? h('div', { class: 'banner' }, 'Demo payments are ON: orders are marked paid without charging anyone. Set PAYSTACK_SECRET_KEY before going live.') : null,
    h('div', { class: 'grid g4' }, st(naira(s.sales.revenue_30d), `Sales, last 30 days (${s.sales.orders_30d} orders)`), st(s.sales.to_fulfil, 'Orders to fulfil'), st(s.products ? s.products.live : '–', 'Products in the shop'), st(s.customers, 'Customers')),
    h('div', { class: 'row', style: 'margin:1rem 0' }, h('a', { class: 'btn', href: '#/admin/products?new=1' }, '+ Add a product'), h('a', { class: 'btn sec', href: '#/admin/orders' }, 'View orders'), h('a', { class: 'btn sec', href: '/', target: '_blank' }, 'Open the shop ↗')),
    h('div', { class: 'grid g2' },
      h('div', { class: 'card' }, h('h3', {}, 'Running low'), s.low_stock.length ? s.low_stock.map(x => h('div', { class: 'row between sm', style: 'padding:.2rem 0' }, h('a', { href: '#/admin/products?edit=' + x.id }, x.name), h('b', {}, x.stock_qty === 0 ? 'Sold out' : x.stock_qty + ' left'))) : h('p', { class: 'muted' }, 'Nothing is running low.')),
      h('div', { class: 'card' }, h('h3', {}, 'Status'), row('Supabase', sb.configured ? (sb.error ? 'problem' : 'connected') : 'not connected'), row('Products in database', sb.count), row('Payments', s.system.payments), row('Sales all time', naira(s.sales.revenue) + ` (${s.sales.orders} orders)`), row('Refunded orders', s.sales.refunded), row('Open support requests', s.open_support)))));
}, { role: ADM });

// ---------- products ----------
function productEditor(prod, categories, done) {
  const p = prod || {}, imgs = [...(p.images || [])], f = {
    name: h('input', { type: 'text', value: p.name || '', maxlength: 200, required: true }), category: h('input', { type: 'text', value: p.category || '', list: 'cat-list', maxlength: 60, placeholder: 'e.g. Footwear' }),
    price: h('input', { type: 'number', min: 0, step: '0.01', value: p.price ?? '', required: true }), compare_at: h('input', { type: 'number', min: 0, step: '0.01', value: p.compare_at ?? '', placeholder: 'optional' }),
    stock_qty: h('input', { type: 'number', min: 0, step: 1, value: p.stock_qty ?? '', placeholder: 'empty = not tracked' }), sizes: h('input', { type: 'text', value: (p.sizes || []).join(', '), placeholder: 'e.g. 40, 41, 42 or S, M, L' }),
    colours: h('input', { type: 'text', value: (p.colours || []).join(', '), placeholder: 'e.g. Black, White' }), description: h('textarea', { maxlength: 4000 }, p.description || ''), specs: h('textarea', { maxlength: 3000, placeholder: 'Material, size guide, what is in the box…' }, p.specs || ''),
    tags: h('input', { type: 'text', value: p.tags || '', placeholder: 'extra search words (optional)' }), active: h('input', { type: 'checkbox', checked: p.active !== false }) };
  const grid = h('div', { class: 'thumbs' }), err = h('div', { class: 'err', role: 'alert' }), file = h('input', { type: 'file', accept: 'image/*', multiple: true }), link = h('input', { type: 'url', placeholder: 'or paste an image link (https://…)' });
  const draw = () => { clear(grid); imgs.forEach((u, i) => grid.append(h('div', { class: 'x' }, thumb(u, 72), i === 0 ? h('span', { class: 'tag', style: 'position:absolute;left:2px;bottom:2px;font-size:.62rem;padding:0 .3rem' }, 'Main') : null,
    h('button', { type: 'button', 'aria-label': 'Remove photo', onclick: () => { imgs.splice(i, 1); draw(); } }, '×'),
    i > 0 ? h('button', { type: 'button', 'aria-label': 'Make main photo', style: 'top:auto;bottom:-6px;right:-6px;background:var(--g)', onclick: () => { imgs.unshift(imgs.splice(i, 1)[0]); draw(); } }, '★') : null))); };
  draw();
  file.addEventListener('change', async () => {
    err.textContent = ''; const files = [...file.files]; file.value = '';
    for (const fl of files) { if (imgs.length >= 8) { err.textContent = 'Up to 8 photos per product.'; break; } try { err.textContent = 'Uploading ' + fl.name + '…'; imgs.push(await uploadImage(fl)); draw(); err.textContent = ''; } catch (e) { err.textContent = e.message; } }
  });
  link.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (/^https?:\/\//.test(link.value.trim()) && imgs.length < 8) { imgs.push(link.value.trim()); link.value = ''; draw(); } } });
  const save = h('button', { class: 'btn', type: 'submit' }, p.id ? 'Save changes' : 'Add to shop');
  const form = h('form', { onsubmit: async e => { e.preventDefault(); err.textContent = ''; save.disabled = true;
    if (/^https?:\/\//.test(link.value.trim()) && imgs.length < 8) imgs.push(link.value.trim());
    const body = { name: f.name.value, category: f.category.value, price: f.price.value, compare_at: f.compare_at.value, stock_qty: f.stock_qty.value, sizes: f.sizes.value, colours: f.colours.value, description: f.description.value, specs: f.specs.value, tags: f.tags.value, active: f.active.checked, images: imgs };
    try { const r = p.id ? await PUT('/api/admin/products/' + p.id, body) : await POST('/api/admin/products', body); toast(p.id ? 'Saved' : 'Added to the shop'); mm.close(); done(r); }
    catch (x) { err.textContent = x.message; save.disabled = false; } } },
    h('datalist', { id: 'cat-list' }, categories.map(c => h('option', { value: c }))),
    field('Product name', f.name), h('div', { class: 'cols2' }, field('Category', f.category, '(shoppers browse by this)'), field('Price (₦)', f.price)),
    h('div', { class: 'cols2' }, field('Old price (₦)', f.compare_at, '(shows a discount badge)'), field('Stock', f.stock_qty, '(how many you have)')),
    h('div', { class: 'cols2' }, field('Sizes', f.sizes, '(comma separated)'), field('Colours', f.colours, '(comma separated)')),
    field('Description', f.description), field('Details', f.specs), field('Search words', f.tags),
    field('Photos', h('div', {}, grid, file, h('div', { style: 'margin-top:.4rem' }, link)), '(up to 8; the first is the main photo; resized automatically)'),
    h('label', { class: 'check' }, f.active, 'Show in the shop'), err, h('div', { class: 'row', style: 'margin-top:.6rem' }, save, h('button', { type: 'button', class: 'btn sec', onclick: () => mm.close() }, 'Cancel')));
  const mm = modal(p.id ? 'Edit product' : 'Add a product', form, { wide: true });
}
route('/admin/products', async (p, root) => {
  let data = await GET('/api/admin/products'), qtext = '', cat = '';
  const body = h('div', {}), draw = () => {
    const rows = data.items.filter(x => (!cat || x.category === cat) && (!qtext || (x.name + ' ' + x.category).toLowerCase().includes(qtext)));
    clear(body).append(rows.length ? table(['', 'Product', 'Category', 'Price', 'Stock', 'Sold', 'Shop', ''], rows.map(x => h('tr', {}, h('td', {}, thumb(x.image)),
      h('td', {}, h('b', {}, x.name), x.compare_at ? h('div', { class: 'muted sm' }, 'was ' + naira(x.compare_at)) : null), h('td', {}, x.category || '–'), h('td', {}, naira(x.price)),
      h('td', {}, x.stock_qty == null ? h('span', { class: 'muted' }, 'not tracked') : x.stock_qty === 0 ? h('span', { class: 'tag bad' }, 'Sold out') : x.stock_qty <= 3 ? h('span', { class: 'tag warn' }, x.stock_qty + ' left') : x.stock_qty), h('td', {}, x.sold || 0),
      h('td', {}, h('button', { class: 'btn sm ' + (x.active ? 'sec' : ''), title: x.active ? 'Click to hide from the shop' : 'Click to show in the shop', onclick: onClick(async () => { await PUT('/api/admin/products/' + x.id, { active: !x.active }); x.active = !x.active; draw(); }) }, x.active ? 'Visible' : 'Hidden')),
      h('td', {}, h('div', { class: 'row' }, h('button', { class: 'btn sm sec', onclick: () => edit(x) }, 'Edit'), h('button', { class: 'btn sm sec danger', onclick: async () => { if (await confirmBox(`Delete “${x.name}” and its photos? This cannot be undone. (Use Hidden to take it off the shop without deleting.)`, 'Delete')) { await DEL('/api/admin/products/' + x.id); data.items = data.items.filter(i => i.id !== x.id); toast('Deleted'); draw(); } } }, 'Delete')))))) :
      h('div', { class: 'card empty' }, data.items.length ? 'No products match.' : [h('h2', {}, 'No products yet'), h('p', {}, 'Add your first product and it appears in the shop straight away.'), h('button', { class: 'btn', onclick: () => edit(null) }, '+ Add a product')]));
  };
  const reload = async () => { data = await GET('/api/admin/products'); draw(); };
  const edit = x => productEditor(x, data.categories, () => reload());
  const search = h('input', { type: 'search', placeholder: 'Search products', 'aria-label': 'Search products', oninput: e => { qtext = e.target.value.trim().toLowerCase(); draw(); } }), sel = h('select', { 'aria-label': 'Category', onchange: e => { cat = e.target.value; draw(); } }, h('option', { value: '' }, 'All categories'), data.categories.map(c => h('option', { value: c }, c)));
  adminLayout(root, h('div', {}, h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, `Products (${data.items.length})`), h('div', { class: 'row' }, h('button', { class: 'btn sec', onclick: onClick(async () => { await reload(); toast('Reloaded from Supabase'); }) }, '↻ Reload'), h('button', { class: 'btn', onclick: () => edit(null) }, '+ Add product'))),
    h('p', { class: 'muted sm' }, 'Products live in your Supabase database. Anything you change here, or directly in the Supabase table editor, shows in the shop within seconds.'),
    h('div', { class: 'row', style: 'margin:.6rem 0' }, h('div', { style: 'flex:1;min-width:200px' }, search), h('div', {}, sel)), body));
  draw();
  const want = App.query || {};
  if (want.new) { history.replaceState(null, '', '#/admin/products'); edit(null); } else if (want.edit) { const x = data.items.find(i => i.id === +want.edit); history.replaceState(null, '', '#/admin/products'); if (x) edit(x); }
}, { role: ADM });

// ---------- orders ----------
const NEXT = { delivery: [['processing', 'Start preparing'], ['dispatched', 'Mark on the way'], ['completed', 'Mark delivered']], pickup: [['processing', 'Start preparing'], ['ready', 'Ready for pickup'], ['completed', 'Mark collected']] };
route('/admin/orders', async (p, root) => {
  const filter = (App.query && App.query.status) || '', list = await GET('/api/admin/orders' + (filter ? '?status=' + filter : ''));
  const chips = [['', 'All'], ['paid', 'New'], ['processing', 'Preparing'], ['dispatched', 'On the way'], ['completed', 'Completed'], ['refunded', 'Refunded']].map(([k, l]) => h('a', { class: 'sf-chip', href: '#/admin/orders' + (k ? '?status=' + k : ''), style: filter === k ? 'background:var(--g);color:#fff' : '' }, l));
  const card = o => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, o.reference), statusTag(o.status)),
    h('div', { class: 'muted sm' }, `${ago(o.created_at)} · ${o.customer_name} · `, h('a', { href: 'tel:' + o.phone }, o.phone), ' · ', h('a', { href: 'mailto:' + o.email }, o.email)),
    o.method === 'delivery' ? h('div', { class: 'sm', style: 'margin:.3rem 0' }, h('b', {}, 'Deliver to: '), o.address) : h('div', { class: 'sm', style: 'margin:.3rem 0' }, h('b', {}, 'Customer will collect')),
    o.items.map(i => h('div', { class: 'row', style: 'padding:.25rem 0' }, thumb(i.image, 40), h('div', { style: 'flex:1' }, h('b', {}, i.name), i.variant ? h('span', { class: 'muted sm' }, ' · ' + i.variant) : null), h('span', {}, `${i.qty} × ${naira(i.unit_price)}`))),
    h('div', { class: 'row between', style: 'margin-top:.4rem' }, h('span', { class: 'sm muted' }, `Items ${naira(o.subtotal)}${o.discount ? ` · discount −${naira(o.discount)}` : ''} · delivery ${o.delivery_fee ? naira(o.delivery_fee) : 'free'}`), h('b', {}, naira(o.total))),
    o.note ? h('div', { class: 'banner', style: 'margin:.5rem 0 0' }, o.note) : null,
    ['paid', 'processing', 'ready', 'dispatched'].includes(o.status) || o.status === 'completed' ? h('div', { class: 'row', style: 'margin-top:.6rem' },
      (NEXT[o.method] || NEXT.delivery).filter(([k]) => k !== o.status && (o.status !== 'completed')).map(([k, l]) => h('button', { class: 'btn sm', onclick: onClick(async () => { await POST(`/api/admin/orders/${o.id}/status`, { status: k }); toast('Order updated'); render(); }) }, l)),
      h('button', { class: 'btn sm sec danger', onclick: async () => { if (await confirmBox(`Refund ${naira(o.total)} to ${o.customer_name} and put the items back in stock?`, 'Refund')) { try { await POST(`/api/admin/orders/${o.id}/refund`); toast('Refunded'); render(); } catch (e) { toast(e.message, 'bad'); } } } }, 'Refund')) : null);
  adminLayout(root, h('div', {}, h('h1', {}, 'Orders'), h('div', { style: 'margin:.4rem 0 .8rem' }, chips), list.length ? list.map(card) : h('div', { class: 'card empty' }, 'No orders here yet. When a customer pays, the order shows up here.')));
}, { role: ADM });

// ---------- customers ----------
route('/admin/customers', async (p, root) => {
  const list = await GET('/api/admin/users');
  adminLayout(root, h('div', {}, h('h1', {}, 'Customers'), table(['Name', 'Email', 'Phone', 'Orders', 'Joined', ''], list.map(u => h('tr', {}, h('td', {}, u.name, u.role === 'admin' ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, 'admin') : null, u.suspended ? h('span', { class: 'tag bad', style: 'margin-left:.4rem' }, 'suspended') : null), h('td', {}, u.email), h('td', {}, u.phone || '–'), h('td', {}, u.orders), h('td', {}, ago(u.created_at)),
    h('td', {}, u.role === 'admin' ? null : h('button', { class: 'btn sm sec', onclick: onClick(async () => { await PATCH('/api/admin/users/' + u.id, { suspended: !u.suspended }); toast('Updated'); render(); }) }, u.suspended ? 'Restore' : 'Suspend')))))));
}, { role: ADM });

// ---------- support ----------
route('/admin/support', async (p, root) => {
  const list = await GET('/api/admin/support');
  adminLayout(root, h('div', {}, h('h1', {}, 'Support requests'), list.length ? list.map(s => { const r = h('textarea', { placeholder: 'Your reply' });
    return h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, s.subject), h('span', { class: 'tag ' + (s.status === 'open' ? 'warn' : '') }, s.status)), h('div', { class: 'muted sm' }, `${s.user_name} · ${s.user_email} · ${ago(s.created_at)}`), h('p', { style: 'white-space:pre-wrap' }, s.message),
      s.admin_reply ? h('div', { class: 'banner info' }, 'Replied: ' + s.admin_reply) : h('div', {}, r, h('button', { class: 'btn sm', style: 'margin-top:.4rem', onclick: onClick(async () => { await POST(`/api/admin/support/${s.id}/reply`, { reply: r.value }); toast('Reply sent'); render(); }) }, 'Send reply'))); }) : h('div', { class: 'card empty' }, 'No support requests.')));
}, { role: ADM });

// ---------- discount codes ----------
route('/admin/discounts', async (p, root) => {
  const list = await GET('/api/admin/discounts'), code = h('input', { type: 'text', maxlength: 20, placeholder: 'WELCOME10', style: 'text-transform:uppercase' }), kind = h('select', {}, h('option', { value: 'percent' }, 'Percent off'), h('option', { value: 'fixed' }, 'Fixed ₦ off')),
    value = h('input', { type: 'number', min: 1 }), min = h('input', { type: 'number', min: 0, placeholder: 'optional' }), max = h('input', { type: 'number', min: 1, placeholder: 'optional' }), exp = h('input', { type: 'date' });
  adminLayout(root, h('div', {}, h('h1', {}, 'Discount codes'), h('div', { class: 'card' }, h('h3', {}, 'New code'), h('div', { class: 'cols2' }, field('Code', code), field('Type', kind)), h('div', { class: 'cols2' }, field('Amount', value, '(percent, or naira)'), field('Minimum order (₦)', min)), h('div', { class: 'cols2' }, field('Max uses', max), field('Expires on', exp)),
    h('button', { class: 'btn', style: 'margin-top:.6rem', onclick: onClick(async () => { await POST('/api/admin/discounts', { code: code.value, kind: kind.value, value: value.value, min_order: min.value, max_uses: max.value, expires_on: exp.value }); toast('Code created'); render(); }) }, 'Create code')),
    list.length ? table(['Code', 'Discount', 'Min order', 'Used', 'Expires', ''], list.map(d => h('tr', {}, h('td', {}, h('b', {}, d.code)), h('td', {}, d.kind === 'percent' ? d.value + '%' : naira(d.value)), h('td', {}, d.min_order ? naira(d.min_order) : '–'), h('td', {}, d.used + (d.max_uses ? ' / ' + d.max_uses : '')), h('td', {}, d.expires_on || 'never'),
      h('td', {}, h('button', { class: 'btn sm sec danger', onclick: onClick(async () => { await DEL('/api/admin/discounts/' + d.id); render(); }) }, 'Delete'))))) : null));
}, { role: ADM });

// ---------- settings ----------
route('/admin/settings', async (p, root) => {
  const s = await GET('/api/admin/settings'), f = { shop_name: h('input', { type: 'text', value: s.shop_name, maxlength: 60 }), delivery_fee: h('input', { type: 'number', min: 0, value: s.delivery_fee }), free_delivery_over: h('input', { type: 'number', min: 0, value: s.free_delivery_over ?? '', placeholder: 'optional' }),
    offers_pickup: h('input', { type: 'checkbox', checked: !!s.offers_pickup }), pickup_info: h('input', { type: 'text', value: s.pickup_info || '', maxlength: 300, placeholder: 'Where and when customers can collect' }), phone: h('input', { type: 'tel', value: s.phone || '' }), whatsapp: h('input', { type: 'tel', value: s.whatsapp || '', placeholder: '0803…' }),
    returns_policy: h('textarea', { maxlength: 600 }, s.returns_policy || '') };
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', minlength: 8, autocomplete: 'new-password' });
  adminLayout(root, h('div', {}, h('h1', {}, 'Settings'), h('div', { class: 'card' }, h('h3', {}, 'Your shop'), field('Shop name', f.shop_name), h('div', { class: 'cols2' }, field('Phone', f.phone), field('WhatsApp', f.whatsapp)), field('Returns policy (shown on product pages)', f.returns_policy)),
    h('div', { class: 'card' }, h('h3', {}, 'Delivery'), h('div', { class: 'cols2' }, field('Delivery fee (₦)', f.delivery_fee), field('Free delivery on orders over (₦)', f.free_delivery_over)), h('label', { class: 'check' }, f.offers_pickup, 'Let customers collect in person (pickup)'), field('Pickup details', f.pickup_info),
      h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'btn', onclick: onClick(async () => { await PUT('/api/admin/settings', { shop_name: f.shop_name.value, delivery_fee: f.delivery_fee.value, free_delivery_over: f.free_delivery_over.value, offers_pickup: f.offers_pickup.checked, pickup_info: f.pickup_info.value, phone: f.phone.value, whatsapp: f.whatsapp.value, returns_policy: f.returns_policy.value }); toast('Settings saved'); }) }, 'Save settings'))),
    h('div', { class: 'card' }, h('h3', {}, 'Your password'), field('Current password', cur), field('New password', nw, '(at least 8 characters)'), h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'btn sec', onclick: onClick(async () => { await PATCH('/api/me', { current_password: cur.value, new_password: nw.value }); cur.value = nw.value = ''; toast('Password changed'); }) }, 'Change password')))));
}, { role: ADM });


// ---------- accounts (profit & loss, balance sheet, cash flow, expenses, downloads) ----------
const fmtN = n => n == null || n === '' ? '' : typeof n !== 'number' ? String(n) : (n < 0 ? '(' + Math.abs(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ')' : n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmt0 = n => n == null ? '–' : (n < 0 ? '-' : '') + '₦' + Math.abs(Math.round(n)).toLocaleString('en-NG');
const PERIODS = [['month', 'This month'], ['lastmonth', 'Last month'], ['quarter', 'This quarter'], ['year', 'This year'], ['fy', 'Financial year'], ['all', 'All time']];
const TABS = [['summary', 'Summary'], ['income', 'Profit & loss'], ['balance', 'Balance sheet'], ['cashflow', 'Cash flow'], ['trial', 'Trial balance'], ['products', 'Product profit'], ['stock', 'Stock value'], ['journal', 'Journal']];
const REC = [['expenses', 'Expenses'], ['money', 'Owner & stock'], ['assets', 'Equipment'], ['costs', 'Cost prices'], ['settings', 'Tax & settings']];
const acctQs = Q => Q.from && Q.to ? `from=${Q.from}&to=${Q.to}` : `preset=${Q.p || 'month'}`;
async function downloadFile(path, filename) {
  const res = await fetch(path, { headers: { Authorization: 'Bearer ' + App.token } });
  if (!res.ok) { let m = 'Download failed'; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
  const url = URL.createObjectURL(await res.blob()), a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}
async function printReport(qs, table) {
  const w = window.open('', '_blank'); if (!w) throw new Error('Allow pop-ups to print, or use Download Excel instead.');
  try { const res = await fetch(`/api/admin/accounts/export?${qs}&format=html${table ? '&table=' + table : ''}`, { headers: { Authorization: 'Bearer ' + App.token } }); if (!res.ok) throw new Error('Could not build the report'); w.location = URL.createObjectURL(await res.blob()); w.addEventListener('load', () => w.print()); }
  catch (e) { w.close(); throw e; }
}
function acctTable(t) {
  const money = c => typeof c === 'number', num = i => t.rows.some(r => money(r.c[i]));
  return h('div', { class: 'card', style: 'padding:.4rem .2rem' }, h('div', { style: 'padding:.4rem .8rem' }, h('h3', { style: 'margin:0' }, t.title), h('div', { class: 'muted sm' }, t.sub || '')),
    h('div', { class: 'tablewrap', style: 'border:0' }, h('table', {}, h('thead', {}, h('tr', {}, t.cols.map((c, i) => h('th', { style: i && num(i) || (i && /%|Margin|units|stock/i.test(c)) ? 'text-align:right' : '' }, c)))),
      h('tbody', {}, t.rows.length ? t.rows.map(r => h('tr', { style: (r.b ? 'font-weight:800;border-top:2px solid var(--line)' : '') + (r.h && !r.b ? ';background:var(--gl);font-weight:700' : '') }, r.c.map((c, i) => h('td', { colspan: r.c.length === 1 ? t.cols.length : null, style: (i === 0 && r.i ? `padding-left:${r.i * 1.2 + .5}rem;` : '') + (money(c) || (i && typeof c === 'string' && /^[\d.,–-]+%?$/.test(c)) ? 'text-align:right;white-space:nowrap;' : '') + (money(c) && c < 0 ? 'color:var(--bad);' : '') }, money(c) ? fmtN(c) : c == null ? '' : c)))) : h('tr', {}, h('td', { colspan: t.cols.length, class: 'muted' }, 'Nothing to show for this period yet.'))))));
}
function monthBars(m) {
  if (!m.length) return h('p', { class: 'muted' }, 'No sales or expenses in this period yet.');
  const max = Math.max(1, ...m.map(x => Math.max(x.revenue, Math.abs(x.profit))));
  return h('div', {}, m.map(x => h('div', { style: 'margin:.45rem 0' }, h('div', { class: 'row between sm' }, h('b', {}, x.month), h('span', { style: 'color:' + (x.profit < 0 ? 'var(--bad)' : 'var(--g)') + ';font-weight:700' }, (x.profit < 0 ? 'Loss ' : 'Profit ') + fmt0(Math.abs(x.profit)))),
    h('div', { style: `height:10px;border-radius:5px;background:var(--gl);overflow:hidden` }, h('div', { style: `height:100%;width:${Math.round(x.revenue / max * 100)}%;background:var(--g2)` })), h('div', { class: 'muted sm' }, `Net revenue ${fmt0(x.revenue)} · cost of goods ${fmt0(x.cogs)} · expenses ${fmt0(x.expenses)}`))));
}
const EXPENSE_NAMES = { rent: 'Rent', salaries: 'Salaries & wages', marketing: 'Marketing & advertising', packaging: 'Packaging', delivery: 'Delivery & logistics', utilities: 'Utilities & power', software: 'Internet & software', transport: 'Transport & travel', repairs: 'Repairs & maintenance', bank: 'Bank & finance charges', other: 'Other expenses' };
const MONEY_NAMES = { capital: 'Owner put money in', drawing: 'Owner took money out', loan_in: 'Loan received', loan_repay: 'Loan repaid (principal)', stock_purchase: 'Stock bought', opening_stock: 'Opening stock (already owned)' };
const MONEY_HELP = { capital: 'Cash you put into the business, including your starting money.', drawing: 'Money you took out for yourself. This is not an expense.', loan_in: 'Borrowed money paid into the business.', loan_repay: 'The borrowed amount you paid back. Record interest as a Bank & finance charge under Expenses.', stock_purchase: 'Goods you paid a supplier for. Their cost becomes an expense only when they are sold.', opening_stock: 'Stock you already had before you started using this page.' };

route('/admin/accounts', async (p, root) => {
  const Q = App.query || {}, tab = Q.tab || 'summary', qs = acctQs(Q);
  const go = (o = {}) => { const base = { tab, ...(Q.from && Q.to ? { from: Q.from, to: Q.to } : { p: Q.p || 'month' }), ...o }; for (const k of Object.keys(base)) if (base[k] == null) delete base[k]; return '#/admin/accounts?' + new URLSearchParams(base).toString(); };
  const needsPeriod = !['costs', 'settings', 'money', 'assets'].includes(tab) || tab === 'expenses';
  const chip = (href, label, on) => h('a', { class: 'sf-chip', href, style: on ? 'background:var(--g);color:#fff' : '' }, label);
  const tabs = h('div', { style: 'margin:.2rem 0 .6rem' }, TABS.map(([k, l]) => chip(go({ tab: k }), l, tab === k)), h('div', { style: 'margin-top:.2rem' }, h('span', { class: 'muted sm' }, 'Records: '), REC.map(([k, l]) => chip(go({ tab: k }), l, tab === k))));
  let periodBar = null;
  if (needsPeriod) {
    const from = h('input', { type: 'date', value: Q.from || '', style: 'width:auto;max-width:11rem' }), to = h('input', { type: 'date', value: Q.to || '', style: 'width:auto;max-width:11rem' });
    periodBar = h('div', { style: 'margin:.2rem 0 .8rem' }, PERIODS.map(([k, l]) => chip('#/admin/accounts?' + new URLSearchParams({ tab, p: k }).toString(), l, !Q.from && (Q.p || 'month') === k)),
      h('div', { class: 'row', style: 'margin-top:.3rem' }, h('span', { class: 'muted sm' }, 'Custom:'), from, h('span', {}, 'to'), to, h('button', { class: 'btn sm sec', onclick: () => { if (from.value && to.value) location.hash = go({ from: from.value, to: to.value }); else toast('Pick both dates', 'bad'); } }, 'Show')));
  }
  const head = (extra) => [h('div', { class: 'row between' }, h('h1', { style: 'margin:0' }, 'Accounts'), extra || null), tabs, periodBar];
  const dl = (table) => h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: onClick(() => downloadFile(`/api/admin/accounts/export?${qs}&format=xlsx`, 'accounts.xlsx')) }, '⬇ Excel (all reports)'),
    table ? h('button', { class: 'btn sm sec', onclick: onClick(() => downloadFile(`/api/admin/accounts/export?${qs}&format=csv&table=${table}`, table + '.csv')) }, 'CSV (this report)') : null,
    h('button', { class: 'btn sm sec', onclick: onClick(() => printReport(qs, table)) }, '🖨 Print / PDF'));
  const page = (...kids) => adminLayout(root, h('div', {}, head(), ...kids));
  const mini = (n, l, tone) => h('div', { class: 'card stat', style: 'margin:0' + (tone ? `;border-top-color:${tone}` : '') }, h('b', { style: 'font-size:1.35rem' }, n), h('span', {}, l));

  // ----- record keeping tabs -----
  if (tab === 'expenses') {
    const list = await GET('/api/admin/accounts/expenses?' + qs), total = list.reduce((t, x) => t + x.amount, 0);
    const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), cat = h('select', {}, Object.entries(EXPENSE_NAMES).map(([k, v]) => h('option', { value: k }, v))), amt = h('input', { type: 'number', min: 0, step: '0.01', placeholder: '0.00' }), desc = h('input', { type: 'text', maxlength: 200, placeholder: 'What was it for?' });
    return page(h('div', { class: 'card' }, h('h3', {}, 'Record an expense'), h('p', { class: 'muted sm' }, 'Money the business spent on running costs. Stock you buy to resell goes under Owner & stock, and equipment under Equipment.'), h('div', { class: 'cols2' }, field('Date', date), field('Category', cat)), h('div', { class: 'cols2' }, field('Amount (₦)', amt), field('Note', desc)),
      h('button', { class: 'btn', style: 'margin-top:.6rem', onclick: onClick(async () => { await POST('/api/admin/accounts/expenses', { date: date.value, category: cat.value, amount: amt.value, description: desc.value }); toast('Expense saved'); render(); }) }, 'Save expense')),
      h('div', { class: 'row between', style: 'margin:.6rem 0' }, h('h3', { style: 'margin:0' }, `Expenses (${list.length}) · ${fmt0(total)}`), h('span', { class: 'muted sm' }, 'Payment-processing fees and depreciation are added for you.')),
      list.length ? table(['Date', 'Category', 'Note', 'Amount', ''], list.map(x => h('tr', {}, h('td', {}, x.date), h('td', {}, EXPENSE_NAMES[x.category] || x.category), h('td', {}, x.description || ''), h('td', { style: 'text-align:right' }, fmtN(x.amount)), h('td', {}, h('button', { class: 'btn sm sec danger', onclick: async () => { if (await confirmBox('Delete this expense? Your reports will change.', 'Delete')) { await DEL('/api/admin/accounts/expenses/' + x.id); render(); } } }, 'Delete'))))) : h('div', { class: 'card empty' }, 'No expenses in this period.'));
  }
  if (tab === 'money') {
    const list = await GET('/api/admin/accounts/money'), kind = h('select', {}, Object.entries(MONEY_NAMES).map(([k, v]) => h('option', { value: k }, v))), help = h('p', { class: 'muted sm' }, MONEY_HELP.capital);
    kind.addEventListener('change', () => { help.textContent = MONEY_HELP[kind.value]; });
    const date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), amt = h('input', { type: 'number', min: 0, step: '0.01' }), desc = h('input', { type: 'text', maxlength: 200, placeholder: 'optional note' });
    return page(h('div', { class: 'card' }, h('h3', {}, 'Owner money, loans and stock bought'), h('p', { class: 'muted sm' }, 'Start here: add the money you started with (Owner put money in) and the value of any stock you already owned (Opening stock). Without these the cash and stock figures start from zero.'), h('div', { class: 'cols2' }, field('What happened', kind), field('Date', date)), help, h('div', { class: 'cols2' }, field('Amount (₦)', amt), field('Note', desc)),
      h('button', { class: 'btn', style: 'margin-top:.6rem', onclick: onClick(async () => { await POST('/api/admin/accounts/money', { kind: kind.value, date: date.value, amount: amt.value, description: desc.value }); toast('Saved'); render(); }) }, 'Save')),
      list.length ? table(['Date', 'What', 'Note', 'Amount', ''], list.map(x => h('tr', {}, h('td', {}, x.date), h('td', {}, MONEY_NAMES[x.kind] || x.kind), h('td', {}, x.description || ''), h('td', { style: 'text-align:right' }, fmtN(x.amount)), h('td', {}, h('button', { class: 'btn sm sec danger', onclick: async () => { if (await confirmBox('Delete this entry? Your reports will change.', 'Delete')) { await DEL('/api/admin/accounts/money/' + x.id); render(); } } }, 'Delete'))))) : h('div', { class: 'card empty' }, 'Nothing recorded yet.'));
  }
  if (tab === 'assets') {
    const list = await GET('/api/admin/accounts/assets'), name = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Shelving, laptop, generator' }), cost = h('input', { type: 'number', min: 0, step: '0.01' }), date = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) }), life = h('input', { type: 'number', min: 0.5, step: '0.5', value: 5 }), salv = h('input', { type: 'number', min: 0, step: '0.01', placeholder: '0' });
    return page(h('div', { class: 'card' }, h('h3', {}, 'Buy equipment'), h('p', { class: 'muted sm' }, 'Things that last for years (shelves, phones, a generator). They are not an expense on the day you buy them: their cost is spread over their useful life as depreciation, charged monthly.'), field('Item', name), h('div', { class: 'cols2' }, field('Cost (₦)', cost), field('Date bought', date)), h('div', { class: 'cols2' }, field('Useful life (years)', life), field('Resale value at the end (₦)', salv)),
      h('button', { class: 'btn', style: 'margin-top:.6rem', onclick: onClick(async () => { await POST('/api/admin/accounts/assets', { name: name.value, cost: cost.value, purchase_date: date.value, life_years: life.value, salvage: salv.value }); toast('Equipment saved'); render(); }) }, 'Save equipment')),
      list.length ? table(['Item', 'Bought', 'Cost', 'Life', 'Per month', ''], list.map(x => h('tr', {}, h('td', {}, x.name), h('td', {}, x.purchase_date), h('td', { style: 'text-align:right' }, fmtN(x.cost)), h('td', {}, x.life_years + ' yrs'), h('td', { style: 'text-align:right' }, fmtN((x.cost - x.salvage) / (x.life_years * 12))), h('td', {}, h('button', { class: 'btn sm sec danger', onclick: async () => { if (await confirmBox('Delete this equipment and its depreciation?', 'Delete')) { await DEL('/api/admin/accounts/assets/' + x.id); render(); } } }, 'Delete'))))) : h('div', { class: 'card empty' }, 'No equipment recorded.'));
  }
  if (tab === 'costs') {
    let list; try { list = await GET('/api/admin/accounts/costs'); } catch (e) { return page(h('div', { class: 'banner bad' }, e.message)); }
    const inputs = new Map(), done = list.filter(x => x.cost != null).length;
    return page(h('div', { class: 'banner info' }, h('b', {}, 'What each product costs you. '), 'This is what lets the shop work out profit on every sale. It is kept privately here and never shown to customers. Sales made before you add a cost are filled in once; after that, changing a cost only affects future sales.'),
      h('div', { class: 'row between', style: 'margin:.4rem 0' }, h('b', {}, `${done} of ${list.length} products have a cost price`), h('button', { class: 'btn', onclick: onClick(async () => { const costs = [...inputs].map(([id, el]) => ({ product_id: id, cost: el.value })); const r = await PUT('/api/admin/accounts/costs', { costs }); toast(`Saved (${r.updated} costs)`); render(); }) }, 'Save all costs')),
      list.length ? table(['Product', 'Selling price', 'Cost price (₦)', 'Profit each'], list.map(x => { const inp = h('input', { type: 'number', min: 0, step: '0.01', value: x.cost ?? '', placeholder: 'cost', style: 'max-width:9rem' }), gain = h('td', { style: 'text-align:right' }, x.cost != null ? fmtN(x.price - x.cost) : '–'); inputs.set(x.id, inp); inp.addEventListener('input', () => { gain.textContent = inp.value === '' ? '–' : fmtN(x.price - +inp.value); });
        return h('tr', {}, h('td', {}, h('b', {}, x.name), h('div', { class: 'muted sm' }, x.category || '')), h('td', { style: 'text-align:right' }, fmtN(x.price)), h('td', {}, inp), gain); })) : h('div', { class: 'card empty' }, 'Add products first.'));
  }
  if (tab === 'settings') {
    const s = await GET('/api/admin/accounts/settings'), f = { vat_enabled: h('input', { type: 'checkbox', checked: !!s.vat_enabled }), vat_rate: h('input', { type: 'number', min: 0, step: '0.1', value: s.vat_rate }), income_tax_rate: h('input', { type: 'number', min: 0, step: '0.1', value: s.income_tax_rate }),
      fees_enabled: h('input', { type: 'checkbox', checked: !!s.fees_enabled }), fee_percent: h('input', { type: 'number', min: 0, step: '0.01', value: s.fee_percent }), fee_flat: h('input', { type: 'number', min: 0, value: s.fee_flat }), fee_flat_over: h('input', { type: 'number', min: 0, value: s.fee_flat_over }), fee_cap: h('input', { type: 'number', min: 0, value: s.fee_cap }),
      fy_start_month: h('select', {}, ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => h('option', { value: i + 1, selected: +s.fy_start_month === i + 1 }, m))) };
    return page(h('div', { class: 'card' }, h('h3', {}, 'Tax'), h('div', { class: 'banner' }, 'These are estimates to help you plan. Tax rules and exemptions depend on your business type and size and change over time, so confirm what applies to you with an accountant or the tax authority before filing.'),
      h('label', { class: 'check' }, f.vat_enabled, 'My shop charges VAT (shelf prices already include it)'), h('div', { class: 'cols2' }, field('VAT rate (%)', f.vat_rate), field('Income tax rate on profit (%)', f.income_tax_rate, '(0 if you do not pay any)')), field('Financial year starts in', f.fy_start_month)),
      h('div', { class: 'card' }, h('h3', {}, 'Payment fees'), h('p', { class: 'muted sm' }, 'The payment provider keeps a fee from each card payment. It is recorded as an expense, worked out from each order. Check these figures against your Paystack statement.'), h('label', { class: 'check' }, f.fees_enabled, 'Record payment fees'),
        h('div', { class: 'cols2' }, field('Percentage (%)', f.fee_percent), field('Flat fee (₦)', f.fee_flat)), h('div', { class: 'cols2' }, field('Flat fee applies from order total (₦)', f.fee_flat_over), field('Fee never more than (₦)', f.fee_cap)),
        h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'btn', onclick: onClick(async () => { const b = {}; for (const [k, el] of Object.entries(f)) b[k] = el.type === 'checkbox' ? el.checked : el.value; await PUT('/api/admin/accounts/settings', b); toast('Saved'); }) }, 'Save settings'))));
  }

  // ----- report tabs -----
  const R = await GET('/api/admin/accounts/report?' + qs); if (!R) throw new Error('The report could not be loaded. Please try again.'); const T = k => R.tables.find(t => t.key === k), warn = R.warnings.map(w => h('div', { class: 'banner' }, '⚠ ' + w));
  const pr = h('div', { class: 'muted sm', style: 'margin:-.2rem 0 .6rem' }, `Showing ${R.period.from < '2001-01-01' ? 'everything up to' : R.period.from + ' to'} ${R.period.to}`);
  if (tab === 'summary') {
    const k = R.kpis, pl = R.pnl, b = R.balance;
    return page(pr, ...warn, h('div', { class: 'row between', style: 'margin-bottom:.6rem' }, h('span', { class: 'muted' }, 'Download everything as one Excel workbook, or print it.'), dl('ratios')),
      h('div', { class: 'grid g4' }, mini(fmt0(pl.net_revenue), `Net revenue (${k.orders} orders)`), mini(fmt0(pl.gross_profit), 'Gross profit' + (k.gross_margin != null ? ` · ${k.gross_margin}% margin` : '')), mini(fmt0(pl.net_profit), pl.net_profit < 0 ? 'Net LOSS' : 'Net profit', pl.net_profit < 0 ? 'var(--bad)' : null), mini(fmt0(b.cash), 'Cash & bank now')),
      h('div', { class: 'grid g4', style: 'margin-top:.8rem' }, mini(fmt0(b.inventory), 'Stock at cost (books)'), mini(fmt0(b.total_liabilities), 'Owed (VAT, loans, tax)'), mini(fmt0(b.total_equity), "Owner's equity"), mini(fmt0(k.avg_order), 'Average order')),
      h('div', { class: 'grid g2', style: 'margin-top:.8rem' },
        h('div', { class: 'card' }, h('h3', {}, 'Is the shop making money?'), h('div', { class: 'sm' },
          [['Contribution margin', k.contribution_margin != null ? k.contribution_margin + '%' : '–', 'what is left of each naira after cost of goods and payment fees'], ['Fixed costs per month', fmt0(k.fixed_costs_monthly), 'rent, salaries, ads, depreciation…'], ['Break-even sales per month', k.break_even_monthly != null ? fmt0(k.break_even_monthly) : '–', 'sell this much to cover all costs'],
           ['Expenses ÷ revenue', k.expense_ratio != null ? k.expense_ratio + '%' : '–', ''], ['Days of stock held', k.days_in_stock != null ? k.days_in_stock + ' days' : '–', 'how long stock sits before selling'], ['Liquidity (cash + stock ÷ debts)', k.liquidity_ratio != null ? k.liquidity_ratio + '×' : 'no debts', 'above 1 is comfortable']]
            .map(([a, v, n]) => h('div', { style: 'padding:.3rem 0;border-bottom:1px solid var(--line)' }, h('div', { class: 'row between' }, a, h('b', {}, v)), n ? h('div', { class: 'muted sm' }, n) : null)))),
        h('div', { class: 'card' }, h('h3', {}, 'Month by month'), monthBars(R.monthly))),
      h('div', { class: 'row', style: 'margin-top:.8rem' }, h('a', { class: 'btn sec', href: go({ tab: 'income' }) }, 'See profit & loss →'), h('a', { class: 'btn sec', href: go({ tab: 'expenses' }) }, '+ Record an expense')),
      T('expenses').rows.length > 1 ? h('div', { style: 'margin-top:.8rem' }, acctTable(T('expenses'))) : null);
  }
  const single = { income: ['income'], balance: ['balance'], cashflow: ['cashflow'], trial: ['trial'], products: ['products', 'categories'], stock: ['stock'], journal: ['journal'] }[tab] || ['income'];
  const notes = { balance: 'Assets (what the shop has) equal liabilities (what it owes) plus the owner\'s equity. Estimated income tax for the period is shown as owed.', trial: 'Every transaction is recorded twice (a debit and a credit), so these two totals always match. If they ever differ, something is wrong.', cashflow: 'Where cash actually came from and went. Profit is not the same as cash: buying stock or equipment uses cash without being an expense.',
    stock: R.stock_summary.catalogue_connected ? `Stock in the books: ${fmt0(R.balance.inventory)}. Counted from your products: ${fmt0(R.stock_summary.value)}${R.stock_summary.without_cost ? ` (${R.stock_summary.without_cost} products have no cost price)` : ''}.` : 'Connect Supabase to see stock.', products: 'Counts sales that were not refunded. Revenue is after discounts and excludes VAT.' };
  page(pr, ...warn, h('div', { class: 'row between', style: 'margin-bottom:.6rem' }, h('span', { class: 'muted sm' }, notes[tab] || ''), dl(single[0])), single.map(k => h('div', { style: 'margin-bottom:.8rem' }, acctTable(T(k)))));
}, { role: ADM });

route('/admin/audit', async (p, root) => {
  const list = await GET('/api/admin/audit');
  adminLayout(root, h('div', {}, h('h1', {}, 'Activity log'), table(['When', 'Who', 'What', 'Details'], list.map(a => h('tr', {}, h('td', {}, ago(a.created_at)), h('td', {}, a.actor || '–'), h('td', {}, a.action), h('td', { class: 'sm' }, a.detail || ''))))));
}, { role: ADM });

// ---------- boot ----------
(async function boot() {
  try { App.meta = await GET('/api/meta'); } catch { $('#app').textContent = 'The shop is unavailable right now. Please try again shortly.'; return; }
  if (App.token) { try { const r = await GET('/api/me', { quiet: true }); App.user = r.user; App.unread = r.unread; } catch { setSession(null, null); } }
  if (!App.user) { sessionStorage.setItem('after_login_admin', location.pathname + location.hash); location.replace('/admin-login.html'); return; }
  if (App.user.role !== 'admin') { location.replace('/'); return; }
  document.title = 'Admin · ' + App.meta.shop.name;
  if (!location.hash || location.hash === '#') location.hash = '#/admin';
  window.addEventListener('hashchange', render);
  await render();
  setInterval(() => { if (document.visibilityState === 'visible') refreshUnread(); }, 30000);
})();
