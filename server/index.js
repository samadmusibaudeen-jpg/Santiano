const http = require('http');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');
const db = require('./db');
const { Router, HttpError, readBody, send, serveStatic, SECURITY_HEADERS } = require('./http');
const { bootstrap } = require('./bootstrap');

const router = new Router();
require('./routes/public')(router);
require('./routes/market')(router);
require('./routes/shop')(router);
require('./routes/admin')(router);
require('./routes/accounting')(router);
const ready = db.ready.then(bootstrap);
ready.catch(e => { console.error('[db] could not start:', e.message); process.exit(1); });

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const pathname = url.pathname;
  await ready;
  res.setHeader('X-Request-Start', Date.now());
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    if (pathname.startsWith('/api/')) {
      const found = router.match(req.method, pathname);
      if (!found) throw new HttpError(404, 'Not found');
      const ctx = { req, res, url, params: found.params, query: Object.fromEntries(url.searchParams), body: {}, rawBody: '', user: null,
        ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
        raw: (status, data, headers) => { ctx.sent = true; res.writeHead(status, headers); res.end(data); } };
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const buf = await readBody(req); ctx.rawBody = buf.toString('utf8');
        if (buf.length) { try { ctx.body = JSON.parse(ctx.rawBody); } catch { throw new HttpError(400, 'Invalid JSON'); } }
      }
      let result;
      for (const h of found.r.handlers) { result = await h(ctx); if (ctx.sent) return; }
      return send(res, 200, result === undefined ? { ok: true } : result, { 'Cache-Control': 'no-store' });
    }
    if (serveStatic(cfg.publicDir, pathname, res)) return;
    // SPA fallback
    if (req.method === 'GET' && !path.extname(pathname)) { serveStatic(cfg.publicDir, '/index.html', res); return; }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[error]', req.method, pathname, e);
    if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Something went wrong on our side. Please try again.' : e.message });
  }
}
if (require.main === module) {
  const server = http.createServer(handle);
  ready.then(() => console.log(`  Database: ${db.kind === 'postgres' ? 'Supabase Postgres (permanent)' : 'local SQLite file (set DATABASE_URL to use Supabase)'}`));
  server.listen(cfg.port, () => {
    console.log(`\n  ${cfg.shopName} shop running on port ${cfg.port}`);
    console.log(`  Public address: ${cfg.publicUrl}${/localhost/.test(cfg.publicUrl) && process.env.NODE_ENV === 'production' ? '  <-- set PUBLIC_URL to your live address' : ''}`);
    console.log(`  Catalogue (Supabase): ${require('./supa').configured() ? cfg.supabaseUrl : 'NOT CONNECTED. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'}`);
    console.log(`  Payments: ${cfg.paystackKey ? 'Paystack' : 'DEMO (orders are marked paid without charging; set PAYSTACK_SECRET_KEY for real payments)'}\n`);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
module.exports = { handle };
