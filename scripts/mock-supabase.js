// A tiny stand-in for Supabase (PostgREST + Storage) so the shop can be developed and tested without a real project.
// Run it alone:  node scripts/mock-supabase.js   (then SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_ROLE_KEY=mock-key npm start)
const http = require('http');
function start(port = 54321, key = 'mock-key') {
  const state = { products: [], nextId: 1, objects: new Map(), calls: [] };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks), url = new URL(req.url, 'http://x'), send = (code, data, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data)); };
      state.calls.push(req.method + ' ' + url.pathname + url.search);
      const pub = url.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
      if (pub) { const o = state.objects.get(decodeURIComponent(pub[2])); return o ? send(200, o.buf, o.type) : send(404, { message: 'not found' }); }
      if (req.headers.apikey !== key || req.headers.authorization !== 'Bearer ' + key) return send(401, { message: 'Invalid API key' });
      const J = () => { try { return JSON.parse(body.toString() || '{}'); } catch { return {}; } };
      if (url.pathname === '/rest/v1/products') {
        const idEq = url.searchParams.get('id'), m = idEq && idEq.match(/^eq\.(\d+)$/), inn = idEq && idEq.match(/^in\.\((.*)\)$/);
        if (req.method === 'GET') {
          let rows = [...state.products]; if (inn) { const s = new Set(inn[1].split(',').map(Number)); rows = rows.filter(r => s.has(r.id)); } if (m) rows = rows.filter(r => r.id === +m[1]);
          rows.sort((a, b) => b.id - a.id); const off = +url.searchParams.get('offset') || 0, lim = +url.searchParams.get('limit') || 1000; return send(200, rows.slice(off, off + lim));
        }
        if (req.method === 'POST') { const d = J(); if (!d.name || d.price == null) return send(400, { message: 'null value in column "name" violates not-null constraint' }); const row = { sizes: [], colours: [], images: [], active: true, stock_qty: null, ...d, id: state.nextId++, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; state.products.push(row); return send(201, [row]); }
        if (req.method === 'PATCH' && m) { const r = state.products.find(p => p.id === +m[1]); if (!r) return send(200, []); Object.assign(r, J()); return send(200, [r]); }
        if (req.method === 'DELETE' && m) { state.products = state.products.filter(p => p.id !== +m[1]); return send(204, ''); }
      }
      if (url.pathname === '/rest/v1/rpc/adjust_stock' && req.method === 'POST') { const { p_id, delta } = J(), r = state.products.find(p => p.id === p_id); if (!r || r.stock_qty == null) return send(200, 'null'); r.stock_qty = Math.max(0, r.stock_qty + delta); return send(200, String(r.stock_qty)); }
      const obj = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      if (obj && req.method === 'POST') { state.objects.set(decodeURIComponent(obj[2]), { buf: body, type: req.headers['content-type'] }); return send(200, { Key: obj[1] + '/' + obj[2] }); }
      if (obj && req.method === 'DELETE') { state.objects.delete(decodeURIComponent(obj[2])); return send(200, { message: 'Successfully deleted' }); }
      send(404, { message: 'mock: no such route ' + url.pathname });
    });
  });
  return new Promise(r => server.listen(port, () => r({ server, state, url: `http://localhost:${port}`, key })));
}
module.exports = { start };
if (require.main === module) start(+process.env.PORT || 54321).then(m => console.log('Mock Supabase on ' + m.url + '  (key: mock-key)'));
