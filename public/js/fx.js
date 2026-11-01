'use strict';
// Motion layer: scroll reveals, looping phone-chat mockup, typewriter placeholder.
// No dependencies, CSP-safe (external file, no innerHTML). Respects prefers-reduced-motion.
(function () {
  const root = document.documentElement;
  root.classList.add('js');
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---------- scroll reveal (also picks up elements the SPA renders later) ----------
  const SEL = '.sf-sec,.sf-dept,.sf-scard,.step-g>div,.feat-g>div,.plan,.cta-g,.sec-g h2,.sec-g .kick,.rv-item';
  let io = null;
  if ('IntersectionObserver' in window && !reduced) {
    io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
  }
  const tag = scope => {
    scope.querySelectorAll(SEL).forEach(n => {
      if (n.dataset.rv) return; n.dataset.rv = '1';
      if (!io) return;
      const sibs = n.parentElement ? [...n.parentElement.children].filter(c => c.matches(SEL)) : [];
      n.style.setProperty('--d', Math.min(sibs.indexOf(n), 6) * 0.07 + 's');
      n.classList.add('rv'); io.observe(n);
    });
  };
  const scan = () => tag(document);
  new MutationObserver(() => { clearTimeout(scan.t); scan.t = setTimeout(scan, 30); }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState !== 'loading') scan(); else document.addEventListener('DOMContentLoaded', scan);

  // ---------- phone chat ----------
  // steps: {t:'me'|'ai', text} | {t:'typing', ms} | {t:'res', items:[{img,name,price,store,href}]} | {t:'card', title, big, sub, row} | {t:'wait', ms}
  function phone(body, steps, { loop = true } = {}) {
    let token = 0;
    const draw = s => {
      let n;
      if (s.t === 'me' || s.t === 'ai') n = el('div', 'bub ' + s.t, s.text);
      else if (s.t === 'res') {
        n = el('div', 'ph-res');
        for (const it of s.items) {
          const a = el(it.href ? 'a' : 'div'); if (it.href) a.href = it.href;
          const pi = el('div', 'pi'); if (it.img) pi.style.backgroundImage = 'url("' + String(it.img).replace(/["\\]/g, '') + '")'; else pi.textContent = it.emoji || '🛍️';
          const pt = el('div', 'pt'); pt.append(el('span', '', it.name), el('b', '', it.price), el('span', '', it.store || ''));
          a.append(pi, pt); n.append(a);
        }
      } else if (s.t === 'card') {
        n = el('div', 'ph-card'); const r = el('div', 'row2'), l = el('div');
        l.append(el('span', '', s.title), el('b', '', s.big), el('small', '', s.sub)); r.append(l); if (s.row) r.append(el('span', 'tag', s.row)); n.append(r);
      }
      return n;
    };
    const trim = () => { while (body.children.length > 6) body.firstElementChild.remove(); };
    async function play() {
      const my = ++token;
      while (my === token && body.isConnected) {
        body.textContent = '';
        for (const s of steps) {
          if (my !== token || !body.isConnected) return;
          if (s.t === 'wait') { await sleep(s.ms); continue; }
          if (s.t === 'typing') { const d = el('div', 'bub ai typing'); d.append(el('i'), el('i'), el('i')); body.append(d); trim(); await sleep(s.ms || 1100); d.remove(); continue; }
          body.append(draw(s)); trim();
          await sleep(s.t === 'me' ? 900 : s.t === 'res' ? 2200 : 1300);
        }
        if (!loop) return;
        await sleep(3200);
      }
    }
    if (reduced) { for (const s of steps) if (s.t !== 'typing' && s.t !== 'wait') { const n = draw(s); n.style.animation = 'none'; n.style.opacity = 1; n.style.transform = 'none'; body.append(n); } trim(); return; }
    // only run while on screen and tab visible
    let vis = true;
    const gate = () => { if (vis && !document.hidden) { if (!body.dataset.run) { body.dataset.run = '1'; play(); } } else { body.dataset.run = ''; token++; } };
    if ('IntersectionObserver' in window) new IntersectionObserver(e => { vis = e[0].isIntersecting; gate(); }).observe(body); else gate();
    document.addEventListener('visibilitychange', gate);
  }

  // ---------- typewriter placeholder ----------
  function typePlaceholder(input, phrases) {
    if (reduced || !input) { if (input) input.placeholder = phrases[0]; return; }
    let i = 0, j = 0, del = false;
    (async function tick() {
      while (input.isConnected) {
        if (document.activeElement === input || input.value) { await sleep(600); continue; }
        const p = phrases[i];
        j += del ? -1 : 1; input.placeholder = p.slice(0, j) + (j % 2 ? '' : '');
        if (!del && j === p.length) { await sleep(1700); del = true; }
        else if (del && j === 0) { del = false; i = (i + 1) % phrases.length; await sleep(350); }
        else await sleep(del ? 22 : 48);
      }
    })();
  }

  window.SFX = { phone, typePlaceholder, reduced };
})();
