'use strict';
// ---------- tiny DOM helper (no innerHTML => no XSS from user content) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  (function add(list) { for (const c of list) { if (c == null || c === false) continue; if (Array.isArray(c)) add(c); else el.append(c.nodeType ? c : document.createTextNode(String(c))); } })(kids);
  return el;
}
const $ = (s, r = document) => r.querySelector(s);
const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const naira = n => n == null ? '' : '₦' + Math.round(+n).toLocaleString('en-NG');
const parseTime = s => new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
function ago(s) {
  const d = (Date.now() - parseTime(s)) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + ' min ago'; if (d < 86400) return Math.floor(d / 3600) + ' h ago';
  if (d < 604800) return Math.floor(d / 86400) + ' d ago'; return parseTime(s).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}
const clock = s => parseTime(s).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });

// ---------- API ----------
const App = { token: localStorage.getItem('santiano_token'), user: null, meta: null, unread: 0, timers: [] };
async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (App.token) headers.Authorization = 'Bearer ' + App.token;
  let res;
  try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { const e = new Error('You appear to be offline. Check your connection and try again.'); e.status = 0; throw e; }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error((data && data.error) || 'Something went wrong'); e.status = res.status;
    if (res.status === 401 && App.token && !opts.quiet) { setSession(null, null); toast('Your session expired. Please sign in again.', 'bad'); setTimeout(() => { location.href = location.pathname.startsWith('/admin') ? '/admin-login.html' : '/login.html'; }, 900); }
    throw e;
  }
  return data;
}
const GET = (p, o) => api('GET', p, undefined, o), POST = (p, b, o) => api('POST', p, b || {}, o), PUT = (p, b) => api('PUT', p, b), PATCH = (p, b) => api('PATCH', p, b), DEL = p => api('DELETE', p);
function setSession(token, user) {
  App.token = token; App.user = user;
  if (token) localStorage.setItem('santiano_token', token); else localStorage.removeItem('santiano_token');
}

// ---------- toast & modal ----------
function toast(msg, kind) {
  const t = h('div', { class: 'toast' + (kind === 'bad' ? ' bad' : ''), role: 'status' }, msg);
  $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3500);
}
function modal(title, body, { wide } = {}) {
  const root = $('#modal-root');
  const close = () => { clear(root); document.removeEventListener('keydown', esc); };
  const esc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  const m = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: wide ? 'max-width:820px' : '' },
    h('div', { class: 'mh' }, h('h2', {}, title), h('button', { 'aria-label': 'Close', onclick: close }, '×')), body);
  clear(root).append(h('div', { class: 'overlay', onclick: e => { if (e.target.classList.contains('overlay')) close(); } }, m));
  return { close, el: m };
}
const confirmBox = (msg, okLabel = 'Confirm') => new Promise(res => {
  const mm = modal('Please confirm', h('div', {}, h('p', {}, msg), h('div', { class: 'row', style: 'justify-content:flex-end' },
    h('button', { class: 'btn sec', onclick: () => { mm.close(); res(false); } }, 'Cancel'), h('button', { class: 'btn danger', onclick: () => { mm.close(); res(true); } }, okLabel))));
});
function busy(btn, fn) { // disable a button while an async action runs
  return async (...a) => { btn.disabled = true; const t = btn.textContent; try { return await fn(...a); } finally { btn.disabled = false; btn.textContent = t; } };
}
const onClick = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(e); } catch (err) { toast(err.message, 'bad'); } finally { b.disabled = false; } };

// ---------- shared UI pieces ----------
function field(label, input, hint) { return h('div', {}, h('label', {}, label, hint ? h('span', { class: 'hint' }, ' ' + hint) : null), input); }
// ---------- router ----------
const routes = [];
const route = (pattern, fn, opts = {}) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); routes.push({ re, keys, fn, opts }); };
function clearTimers() { App.timers.forEach(clearInterval); App.timers = []; }
const poll = (fn, ms) => { App.timers.push(setInterval(fn, ms)); };
async function render() {
  clearTimers();
  const hash = location.hash.replace(/^#/, '') || '/', [pathPart, queryStr] = hash.split('?');
  App.query = Object.fromEntries(new URLSearchParams(queryStr || ''));
  for (const r of routes) {
    const m = r.re.exec(pathPart); if (!m) continue;
    const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
    if (r.opts.role && (!App.user || !r.opts.role.includes(App.user.role))) { if (!App.user) { sessionStorage.setItem('after_login', location.pathname + location.hash); location.href = '/login.html'; } else location.href = homeFor(App.user); return; }
    const root = $('#app'); window.scrollTo(0, 0);
    try { await r.fn(params, root); } catch (e) { console.error(e); clear(root).append(layoutPublic(h('div', { class: 'card empty' }, h('h2', {}, 'Something went wrong'), h('p', {}, e.message), h('a', { class: 'btn', href: '/' }, 'Back home')))); }
    return;
  }
  clear($('#app')).append(layoutPublic(h('div', { class: 'card empty' }, h('h2', {}, 'Page not found'), h('a', { class: 'btn', href: '/' }, 'Go home'))));
}
const homeFor = u => !u ? '/' : u.role === 'admin' ? '/admin.html#/admin' : '/';
async function refreshUnread() { if (!App.token) return; try { const r = await GET('/api/me', { quiet: true }); App.unread = r.unread; const b = $('#bell-count'); if (b) { b.textContent = r.unread || ''; b.style.display = r.unread ? '' : 'none'; } } catch {} }
async function showNotifications() {
  const list = await GET('/api/notifications');
  const body = list.length ? h('div', { class: 'list' }, list.map(n => h('a', { class: 'item', href: n.link || '#', onclick: () => document.querySelector('.overlay')?.remove() }, h('b', {}, (n.is_read ? '' : '● ') + n.title), h('span', { class: 'muted sm' }, (n.body || '') + ' · ' + ago(n.created_at))))) : h('div', { class: 'empty' }, 'No notifications yet.');
  modal('Notifications', body); await POST('/api/notifications/read'); App.unread = 0; refreshUnread();
}
function logout() { const adm = App.user && App.user.role === 'admin'; setSession(null, null); location.href = adm ? '/admin-login.html' : '/'; }

function topbar(extraNav = []) {
  const u = App.user;
  const nav = [];
  if (!u) nav.push(h('a', { href: '/' }, 'Shop'), h('a', { href: '/login.html' }, 'Sign in'), h('a', { class: 'btn sm', href: '/register.html' }, 'Create account'));
  else {
    if (u.role === 'admin') nav.push(h('a', { href: '/' }, 'View shop'));
    nav.push(h('button', { class: 'lnk', 'aria-label': 'Notifications', onclick: () => showNotifications().catch(e => toast(e.message, 'bad')) }, '🔔', h('span', { class: 'badge-dot', id: 'bell-count', style: App.unread ? '' : 'display:none' }, App.unread || '')),
      h('a', { href: '/admin.html#/admin/settings' }, u.name.split(' ')[0]), h('button', { class: 'lnk', onclick: logout }, 'Sign out'));
  }
  return h('header', { class: 'topbar' }, h('a', { class: 'brand', href: u ? homeFor(u) : '/' }, h('i', {}, 'S'), 'Santiano'), h('div', { class: 'spacer' }), h('nav', { class: 'nav' }, extraNav, nav));
}
const footer = () => h('footer', { class: 'f' }, (App.meta && App.meta.shop ? App.meta.shop.name : 'Santiano') + ' admin');
function layoutPublic(content, { narrow } = {}) { return h('div', {}, topbar(), h('main', { class: 'wrap', style: narrow ? 'max-width:760px' : '' }, content), footer()); }
function layoutSide(items, content, title) {
  const hash = location.hash.split('?')[0];
  return h('div', {}, topbar(), h('div', { class: 'shell' },
    h('nav', { class: 'side', 'aria-label': title }, items.map(it => it.group ? h('div', { class: 'grp' }, it.group) : h('a', { href: it.href, class: hash === it.href || (it.href !== items[1]?.href && hash.startsWith(it.href + '/')) ? 'on' : '' }, it.label, it.count ? h('span', { class: 'pill' }, it.count) : null))),
    h('main', {}, content)), footer());
}

// image upload (resize client-side to keep uploads small)
function resizeImage(file, max = 900) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); resolve(c.toDataURL('image/jpeg', 0.82)); };
    img.onerror = () => reject(new Error('That file could not be read as an image')); img.src = url;
  });
}
async function uploadImage(file) { const data_url = await resizeImage(file, 1200); return (await POST('/api/admin/uploads', { data_url })).url; }
