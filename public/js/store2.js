'use strict';
// Shopper storefront, part 2: cart, checkout, orders, wishlist, account, boot.

// ---------- cart ----------
async function loadCart() {
  const items = Cart.items(); if (!items.length) return null;
  const c = await POST('/api/market/cart', { items }, { quiet: true });
  // keep the stored quantities in line with what the server says is available
  const a = Cart.items(); let changed = false;
  c.items.forEach(i => { const f = a.find(x => Cart.same(x, i.product ? i.product.id : i.product_id, i.size, i.colour)); if (f && i.product && i.qty < f.qty) { f.qty = i.qty; changed = true; } });
  if (changed) ls.set('santiano_cart', a);
  return c;
}
const buyable = i => i.product && (!i.problem || /^Only \d+ left$/.test(i.problem));
store('/cart', async () => {
  document.title = 'Cart · ' + (shopInfo().name || 'Santiano');
  const c = await loadCart();
  if (!c) return emptyState('Your cart is empty', 'Find something you like and add it to your cart.', h('a', { class: 'btn', href: '#/' }, 'Start shopping'));
  const refresh = () => go(), sh = c.shop || {}, ok = c.items.some(buyable);
  const line = it => {
    if (!it.product) return h('div', { class: 'sf-line' }, h('div', {}), h('div', {}, h('b', {}, 'This item is no longer available'), h('div', { class: 'err' }, it.problem)), h('div', { class: 'rt' }, h('button', { class: 'btn sm sec', onclick: () => { Cart.remove(it.product_id, it.size, it.colour); refresh(); } }, 'Remove')));
    const p = it.product, bad = it.problem && !/^Only \d+ left$/.test(it.problem);
    return h('div', { class: 'sf-line' }, h('a', { href: link('/p/' + p.id) }, h('img', { src: p.image, alt: p.name })),
      h('div', {}, h('a', { href: link('/p/' + p.id), style: 'font-weight:600;color:var(--ink)' }, p.name), it.variant ? h('div', { class: 'muted sm' }, it.variant) : null, it.problem ? h('div', { class: bad ? 'err' : 'sm', style: bad ? '' : 'color:var(--warn)' }, it.problem) : null,
        h('button', { class: 'btn ghost sm', style: 'padding-left:0', onclick: () => { Cart.remove(p.id, it.size, it.colour); refresh(); } }, 'Remove')),
      h('div', { class: 'rt' }, h('b', {}, naira(p.price)), bad && it.problem === 'Out of stock' ? null : h('div', { class: 'sf-qty', style: 'margin-top:.3rem' }, h('button', { 'aria-label': 'Fewer', onclick: () => { Cart.setQty(p.id, it.size, it.colour, it.qty - 1); refresh(); } }, '−'), h('span', {}, it.qty), h('button', { 'aria-label': 'More', onclick: () => { Cart.setQty(p.id, it.size, it.colour, it.qty + 1); refresh(); } }, '+'))));
  };
  const left = sh.free_delivery_over ? sh.free_delivery_over - c.subtotal : 0;
  return h('div', { class: 'sf-cols' }, h('div', {}, h('h1', {}, 'Your cart'), h('div', { class: 'sf-group' }, c.items.map(line))),
    h('aside', { class: 'sf-sum' }, h('h3', {}, 'Order summary'), h('div', { class: 'ln' }, h('span', {}, 'Items'), h('b', {}, naira(c.subtotal))),
      h('p', { class: 'muted sm' }, sh.delivery_fee ? `Delivery ${naira(sh.delivery_fee)}${sh.free_delivery_over ? ` · free over ${naira(sh.free_delivery_over)}` : ''}. Discount codes are added at checkout.` : 'Free delivery. Discount codes are added at checkout.'),
      sh.free_delivery_over && left > 0 && c.subtotal > 0 ? h('div', { class: 'sf-box' }, `Add ${naira(left)} more for free delivery 🚚`) : null,
      h('a', { class: 'btn', style: 'width:100%', href: ok ? link('/checkout') : null, 'aria-disabled': !ok }, 'Checkout'), h('a', { class: 'btn ghost', style: 'width:100%;margin-top:.3rem', href: '#/' }, 'Continue shopping')));
});

// ---------- checkout ----------
store('/checkout', async () => {
  document.title = 'Checkout · ' + (shopInfo().name || 'Santiano');
  const c = await loadCart(), lines = c ? c.items.filter(buyable) : [];
  if (!lines.length) return emptyState('Nothing to check out', 'Your cart has no available items.', h('a', { class: 'btn', href: link('/cart') }, 'Back to cart'));
  const sh = c.shop || {}, u = App.user && App.user.role === 'customer' ? App.user : null;
  const f = { name: h('input', { type: 'text', value: u ? u.name : '', autocomplete: 'name', required: true }), phone: h('input', { type: 'tel', value: u ? (u.phone || '') : '', autocomplete: 'tel', required: true }), email: h('input', { type: 'email', value: u ? u.email : '', autocomplete: 'email', required: true }),
    address: h('textarea', { placeholder: 'House number, street, area, city, state', autocomplete: 'street-address' }, u ? (u.address || '') : ''), code: h('input', { type: 'text', placeholder: 'Discount code', style: 'text-transform:uppercase' }) };
  const canPick = !!sh.offers_pickup; let method = 'delivery';
  const sum = h('div', {}), err = h('div', { class: 'err', role: 'alert' }), codeMsg = h('div', { class: 'sm' }), addrBox = h('div', {}, field('Delivery address', f.address));
  const payBtn = h('button', { class: 'btn', style: 'width:100%;margin-top:.8rem', type: 'submit' }, 'Pay securely');
  const items = lines.map(i => ({ product_id: i.product.id, qty: i.qty, size: i.size || '', colour: i.colour || '' }));
  let quote = null;
  async function requote() {
    try { quote = await POST('/api/shop/quote', { items, method, code: f.code.value.trim() || undefined }, { quiet: true }); codeMsg.textContent = quote.code ? `Code ${quote.code} applied` : ''; codeMsg.style.color = 'var(--g)'; }
    catch (e) { codeMsg.textContent = e.message; codeMsg.style.color = 'var(--bad)'; try { quote = await POST('/api/shop/quote', { items, method }, { quiet: true }); } catch {} }
    clear(sum).append(...[h('div', { class: 'ln' }, h('span', {}, `Items (${lines.reduce((a, i) => a + i.qty, 0)})`), h('span', {}, naira(quote.subtotal))), quote.discount ? h('div', { class: 'ln' }, h('span', {}, 'Discount'), h('span', { style: 'color:var(--g)' }, '−' + naira(quote.discount))) : null,
      h('div', { class: 'ln' }, h('span', {}, 'Delivery'), h('span', {}, method === 'pickup' ? 'Pickup' : quote.fee ? naira(quote.fee) : 'Free')), h('div', { class: 'ln tot' }, h('span', {}, 'Total'), h('span', {}, naira(quote.total)))].filter(Boolean));
    payBtn.textContent = 'Pay ' + naira(quote.total) + ' securely';
  }
  const methods = h('div', { class: 'row', role: 'radiogroup', 'aria-label': 'How do you want it?' });
  const drawMethods = () => { clear(methods); [['delivery', '🚚 Delivery'], canPick && ['pickup', '🏬 Pickup']].filter(Boolean).forEach(([k, l]) => methods.append(h('button', { type: 'button', role: 'radio', 'aria-checked': method === k, class: 'btn ' + (method === k ? '' : 'sec'), onclick: () => { method = k; addrBox.hidden = k !== 'delivery'; drawMethods(); requote(); } }, l))); }; drawMethods();
  const form = h('form', { onsubmit: async e => { e.preventDefault(); err.textContent = ''; payBtn.disabled = true; payBtn.textContent = 'Starting payment…';
    try { const r = await POST('/api/shop/checkout', { name: f.name.value, phone: f.phone.value, email: f.email.value, method, address: method === 'delivery' ? f.address.value : '', code: f.code.value.trim() || undefined, items }, { quiet: true }); location.href = r.authorization_url; }
    catch (x) { err.textContent = x.message; payBtn.disabled = false; requote(); } } },
    !u ? h('div', { class: 'banner info' }, h('a', { href: '/login.html', onclick: () => sessionStorage.setItem('after_login', location.pathname + location.hash) }, 'Sign in'), ' or ', h('a', { href: '/register.html', onclick: () => sessionStorage.setItem('after_login', location.pathname + location.hash) }, 'create an account'), ' to track this order and review what you buy. You can also continue as a guest.') : null,
    h('h3', {}, '1. Contact'), h('div', { class: 'cols2' }, field('Full name', f.name), field('Phone', f.phone)), field('Email', f.email, '(your receipt is sent here)'),
    h('h3', { style: 'margin-top:1rem' }, '2. Delivery'), methods, addrBox, canPick && sh.pickup_info ? h('div', { class: 'muted sm', id: 'pick-info' }, 'Pickup: ' + sh.pickup_info) : null,
    !sh.payments_enabled ? h('div', { class: 'err' }, 'Online payments are not switched on yet.') : null,
    h('h3', { style: 'margin-top:1rem' }, '3. Discount'), h('div', { class: 'row' }, h('div', { style: 'flex:1' }, f.code), h('button', { type: 'button', class: 'btn sec', onclick: () => requote() }, 'Apply')), codeMsg,
    err, payBtn, h('p', { class: 'muted sm' }, 'You will be taken to Paystack to pay by card, bank transfer or USSD.'));
  if (!sh.payments_enabled) payBtn.disabled = true;
  await requote();
  return h('div', {}, h('div', { class: 'sf-crumb' }, h('a', { href: link('/cart') }, '← Back to cart')), h('h1', {}, 'Checkout'), h('div', { class: 'sf-cols' }, h('div', { class: 'card' }, form),
    h('aside', { class: 'sf-sum' }, h('h3', {}, 'Order summary'), lines.map(i => h('div', { class: 'ln sm' }, h('span', {}, `${i.qty} × ${i.product.name}${i.variant ? ' (' + i.variant + ')' : ''}`), h('span', {}, naira(i.line_total)))), sum)));
});

// ---------- order confirmation / tracking ----------
const STEP = { paid: 0, processing: 1, ready: 2, dispatched: 2, completed: 3 };
store('/order/:ref', async ({ ref }) => {
  document.title = 'Your order · ' + (shopInfo().name || 'Santiano');
  const o = await GET('/api/shop/order/' + encodeURIComponent(ref)), paid = o.status in STEP, ids = new Set(o.items.map(i => i.product_id));
  if (paid) Cart.removeWhere(i => ids.has(i.product_id));
  const head = paid ? h('div', { class: 'sf-ok' }, h('div', { class: 'tick' }, '✓'), h('h1', {}, 'Thank you, your order is confirmed'), h('p', { class: 'muted' }, `${o.shop} has your order and will prepare it now. We will email you updates.`))
    : o.status === 'pending_payment' ? h('div', { class: 'sf-ok' }, h('h1', {}, 'Payment not confirmed yet'), h('p', {}, 'If you were charged, wait a minute and refresh this page.'), h('button', { class: 'btn', onclick: () => go() }, 'Refresh'))
    : h('div', { class: 'sf-ok' }, h('h1', {}, 'Order ' + o.status), o.status === 'refunded' ? h('p', {}, 'Your payment is being refunded to the original payment method. Banks can take a few days.') : null);
  const labels = ['Paid', 'Preparing', o.method === 'pickup' ? 'Ready for pickup' : 'On the way', 'Completed'], cur = STEP[o.status];
  return h('div', { style: 'max-width:760px;margin:0 auto' }, head, paid ? h('div', { class: 'sf-steps', 'aria-label': 'Order progress' }, labels.map((l, i) => h('div', { class: i <= cur ? 'on' : '' }, l))) : null,
    h('div', { class: 'card' }, h('div', { class: 'row between' }, h('b', {}, 'Order ' + o.reference), h('span', { class: 'tag ' + (paid ? '' : 'warn') }, o.status.replace('_', ' '))), h('div', { class: 'muted sm' }, ago(o.created_at)),
      o.items.map(i => h('div', { class: 'sf-line', style: 'padding-left:0;padding-right:0' }, h('img', { src: i.image, alt: '' }), h('div', {}, h('b', {}, i.name), i.variant ? h('div', { class: 'muted sm' }, i.variant) : null, h('div', {}, i.qty + ' × ' + naira(i.unit_price)), paid && i.product_id ? h('div', {}, h('a', { class: 'sm', href: link('/p/' + i.product_id) }, 'View / review this item')) : null), h('b', {}, naira(i.qty * i.unit_price)))),
      h('div', { class: 'sf-sum', style: 'position:static;border:0;padding:.5rem 0 0' }, h('div', { class: 'ln' }, h('span', {}, 'Items'), h('span', {}, naira(o.subtotal))), o.discount ? h('div', { class: 'ln' }, h('span', {}, 'Discount ' + (o.discount_code || '')), h('span', {}, '−' + naira(o.discount))) : null, h('div', { class: 'ln' }, h('span', {}, 'Delivery'), h('span', {}, o.delivery_fee ? naira(o.delivery_fee) : o.method === 'pickup' ? 'Pickup' : 'Free')), h('div', { class: 'ln tot' }, h('span', {}, 'Total paid'), h('span', {}, naira(o.total)))),
      o.method === 'delivery' && o.address ? h('p', { class: 'sm' }, h('b', {}, 'Delivering to: '), o.address) : null),
    h('div', { class: 'row', style: 'margin-top:1rem' }, h('a', { class: 'btn', href: '#/' }, 'Continue shopping'), Cart.count() ? h('a', { class: 'btn sec', href: link('/cart') }, `Back to cart (${Cart.count()})`) : null, App.user ? h('a', { class: 'btn sec', href: link('/orders') }, 'My orders') : null));
});

store('/orders', async () => {
  if (needLogin()) return; document.title = 'My orders · ' + (shopInfo().name || 'Santiano');
  const list = await GET('/api/shop/my-orders');
  return h('div', { style: 'max-width:820px;margin:0 auto' }, h('h1', {}, 'My orders'), list.length ? list.map(o => h('a', { class: 'card', style: 'display:block;color:inherit;margin-bottom:.7rem', href: link('/order/' + o.reference) },
    h('div', { class: 'row between' }, h('b', {}, o.reference), h('span', { class: 'tag ' + (o.status === 'completed' ? '' : o.status in STEP ? 'blue' : 'grey') }, o.status.replace('_', ' '))), h('div', { class: 'muted sm' }, ago(o.created_at)),
    h('div', { class: 'row', style: 'margin:.4rem 0' }, o.items.slice(0, 5).map(i => h('img', { src: i.image, alt: i.name, style: 'width:52px;height:52px;object-fit:cover;border-radius:8px' }))), h('div', {}, o.items.map(i => `${i.qty} × ${i.name}`).join(', ')), h('b', {}, naira(o.total))))
    : emptyState('No orders yet', 'When you buy something it will show up here.', h('a', { class: 'btn', href: '#/' }, 'Start shopping')));
});

// ---------- wishlist ----------
store('/wishlist', async () => {
  document.title = 'Wishlist · ' + (shopInfo().name || 'Santiano');
  const ids = Wish.ids(), items = ids.length ? await POST('/api/market/products/by-ids', { ids }) : [];
  return h('div', {}, h('h1', {}, 'Your wishlist'), items.length ? grid(items) : emptyState('Nothing saved yet', 'Tap the heart on any product to save it here. Saved items stay in this browser.', h('a', { class: 'btn', href: '#/' }, 'Browse products')));
});

// ---------- account ----------
store('/account', async () => {
  if (needLogin()) return; document.title = 'My account · ' + (shopInfo().name || 'Santiano');
  const u = App.user, name = h('input', { type: 'text', value: u.name }), phone = h('input', { type: 'tel', value: u.phone || '' }), address = h('textarea', { placeholder: 'Used to pre-fill checkout' }, u.address || '');
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', minlength: 8, autocomplete: 'new-password' });
  const support = () => { const s = h('input', { type: 'text', maxlength: 120 }), m = h('textarea', { maxlength: 2000 }); const mm = modal('Contact support', h('div', {}, field('Subject', s), field('Message', m), h('button', { class: 'btn', style: 'margin-top:.8rem', onclick: onClick(async () => { await POST('/api/support', { subject: s.value, message: m.value }); mm.close(); toast('Message sent. We will reply in your notifications.'); }) }, 'Send'))); };
  return h('div', { style: 'max-width:640px;margin:0 auto' }, h('h1', {}, 'My account'),
    h('div', { class: 'card' }, field('Name', name), field('Email', h('input', { type: 'text', value: u.email, disabled: true })), field('Phone', phone), field('Delivery address', address), h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'btn', onclick: onClick(async () => { const r = await PATCH('/api/me', { name: name.value, phone: phone.value, address: address.value }); App.user = r.user; toast('Saved'); }) }, 'Save changes'))),
    h('div', { class: 'card' }, h('h3', {}, 'Password'), field('Current password', cur), field('New password', nw, '(at least 8 characters)'), h('div', { style: 'margin-top:.8rem' }, h('button', { class: 'btn sec', onclick: onClick(async () => { await PATCH('/api/me', { current_password: cur.value, new_password: nw.value }); cur.value = nw.value = ''; toast('Password changed'); }) }, 'Change password'))),
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('a', { class: 'btn sec', href: link('/orders') }, 'My orders'), h('button', { class: 'btn sec', onclick: () => showNotifications().catch(e => toast(e.message, 'bad')) }, '🔔 Notifications'), h('button', { class: 'btn sec', onclick: support }, 'Contact support'), h('button', { class: 'btn ghost', onclick: logout }, 'Sign out'))),
    h('div', { class: 'card' }, h('h3', {}, 'Privacy'), h('p', { class: 'muted sm' }, 'Deleting your account removes your profile and reviews. Past orders are kept for our records but are no longer linked to you.'),
      h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Delete your account? This cannot be undone.', 'Delete account')) { await DEL('/api/me'); setSession(null, null); location.href = '/'; } } }, 'Delete my account')));
});

// ---------- boot ----------
(async function boot() {
  const root = $('#app');
  try { App.meta = await GET('/api/meta'); } catch { root.textContent = 'The shop is unavailable right now. Please try again shortly.'; return; }
  if (App.token) { try { const r = await GET('/api/me', { quiet: true }); App.user = r.user; } catch { setSession(null, null); } }
  SF.view = h('main', { class: 'sf-main', id: 'view', tabindex: '-1' });
  clear(root).append(drawHeader(), SF.view, drawFooter()); SF.badges();
  window.addEventListener('hashchange', go); window.addEventListener('storage', SF.badges);
  await go();
})();
