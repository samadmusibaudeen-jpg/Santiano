'use strict';
// Sign-in, registration, forgot/reset password. Standalone pages (login.html, register.html).
const page = document.body.dataset.page, isAdmin = page === 'admin-login', LOGIN = isAdmin ? '/admin-login.html' : '/login.html', params = new URLSearchParams(location.search);

function shell(title, sub, ...body) {
  return h('div', {}, h('header', { class: 'topbar' }, h('a', { class: 'brand', href: '/' }, h('i', {}, 'S'), 'Santiano'), h('div', { class: 'spacer' }), h('nav', { class: 'nav' }, h('a', { href: '/' }, 'Home'))),
    h('main', { class: 'wrap' }, h('div', { class: 'card auth' + (isAdmin ? ' admin-auth' : '') }, isAdmin ? h('span', { class: 'chip' }, 'Admin portal') : null, h('h1', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, body)));
}
function goAfterLogin(user) {
  if (isAdmin) { sessionStorage.removeItem('after_login'); const b = sessionStorage.getItem('after_login_admin'); sessionStorage.removeItem('after_login_admin'); location.href = b && b.startsWith('/admin.html') ? b : homeFor(user); return; }
  const back = sessionStorage.getItem('after_login'); sessionStorage.removeItem('after_login');
  const home = homeFor(user), safe = back && back.startsWith('/') && !back.startsWith('//') && !back.startsWith('/login') && !back.startsWith('/register');
  if (user.role === 'customer') { location.href = safe ? back : '/'; return; }
  location.href = safe && back.startsWith(home.split('#')[0]) ? back : home;
}
function drawLogin(root, mode) {
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, value: params.get('email') || '' }), pw = h('input', { type: 'password', autocomplete: 'current-password', required: true }), err = h('div', { class: 'err', role: 'alert' });
  const form = h('form', { onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    try {
      const r = await POST('/api/auth/login', { email: email.value, password: pw.value, portal: isAdmin ? 'admin' : 'buyer' });
      setSession(r.token, r.user); goAfterLogin(r.user);
    } catch (x) { err.textContent = x.message; }
  } }, field('Email', email), field('Password', pw), err, h('button', { class: 'btn', style: 'width:100%;margin-top:.8rem', type: 'submit' }, 'Sign in'),
    h('p', { class: 'sm' }, h('a', { href: '#', onclick: e => { e.preventDefault(); drawForgot(root); } }, 'Forgot password?'), isAdmin ? null : [' · ', h('a', { href: '/register.html' }, 'Create an account')]),
  );
  clear(root).append(isAdmin
    ? shell('Admin sign in', 'Restricted to shop administrators.', form, h('p', { class: 'sm' }, h('a', { href: '/login.html' }, 'Shopping? Buyer sign in →')))
    : shell('Sign in', 'Buyer account', form, h('p', { class: 'sm' }, h('a', { href: '/' }, 'Continue browsing without an account')), h('p', { class: 'sm muted' }, 'Shop admin? ', h('a', { href: '/admin-login.html' }, 'Admin sign in'))));
}
function drawForgot(root) {
  const email = h('input', { type: 'email', required: true }), out = h('div', {});
  const form = h('form', { onsubmit: async e => { e.preventDefault(); try { const r = await POST('/api/auth/forgot', { email: email.value, portal: isAdmin ? 'admin' : 'buyer' }); clear(out).append(h('div', { class: 'banner info' }, r.message), r.dev_reset_token ? h('p', { class: 'sm' }, 'Dev mode: ', h('a', { href: LOGIN + '?reset=' + r.dev_reset_token }, 'open reset link')) : null); } catch (x) { toast(x.message, 'bad'); } } },
    field('Email', email), h('button', { class: 'btn', style: 'width:100%;margin-top:.8rem' }, 'Send reset link'), out, h('p', { class: 'sm' }, h('a', { href: LOGIN }, '← Back to sign in')));
  clear(root).append(shell('Reset password', 'We\'ll send a reset link if the email is registered.', form));
}
function drawReset(root, token) {
  const pw = h('input', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }), err = h('div', { class: 'err' });
  const form = h('form', { onsubmit: async e => { e.preventDefault(); try { await POST('/api/auth/reset', { token, password: pw.value }); toast('Password updated. Please sign in.'); setTimeout(() => location.href = LOGIN, 900); } catch (x) { err.textContent = x.message; } } }, field('New password', pw), err, h('button', { class: 'btn', style: 'width:100%;margin-top:.8rem' }, 'Set password'));
  clear(root).append(shell('Choose a new password', '', form));
}
function drawRegister(root, meta) {
  const name = h('input', { type: 'text', required: true, autocomplete: 'name' }), email = h('input', { type: 'email', required: true, autocomplete: 'email' }), phone = h('input', { type: 'tel', autocomplete: 'tel' }),
    pw = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' }), address = h('input', { type: 'text', autocomplete: 'street-address', maxlength: 250 }), err = h('div', { class: 'err', role: 'alert' });
  const form = h('form', { onsubmit: async e => { e.preventDefault(); err.textContent = '';
    try { const r = await POST('/api/auth/register', { name: name.value, email: email.value, phone: phone.value, password: pw.value, address: address.value }); setSession(r.token, r.user);
      location.href = (() => { const b = sessionStorage.getItem('after_login'); sessionStorage.removeItem('after_login'); return b && b.startsWith('/') && !b.startsWith('//') && !b.startsWith('/register') && !b.startsWith('/login') ? b : '/'; })(); } catch (x) { err.textContent = x.message; } } },
    field('Full name', name), field('Email', email), field('Phone', phone, '(optional)'), field('Delivery address', address, '(optional; saves time at checkout)'), field('Password', pw, '(at least 8 characters)'), err,
    h('button', { class: 'btn', style: 'width:100%;margin-top:.8rem', type: 'submit' }, 'Create account'),
    h('p', { class: 'sm muted' }, 'We only ask for what we need. Your details are used to deliver your orders.'),
    h('p', { class: 'sm' }, 'Already registered? ', h('a', { href: '/login.html' }, 'Sign in')));
  clear(root).append(shell('Create your account', '', form));
}
(async function () {
  const root = document.getElementById('app');
  try { const u = App.token && (await GET('/api/me', { quiet: true })).user; if (u && !params.get('reset')) { location.replace(homeFor(u)); return; } } catch { setSession(null, null); }
  if (params.get('reset')) return drawReset(root, params.get('reset'));
  if (page === 'register') { let meta; try { meta = await GET('/api/meta'); } catch { meta = { areas: [] }; } return drawRegister(root, meta); }
  drawLogin(root);
})();
