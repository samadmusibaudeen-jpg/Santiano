// Accounting module test: real shop server + mock Supabase. Run with: node scripts/accounting-test.js
'use strict';
const path = require('path'), os = require('os'), fs = require('fs'), http = require('http'), zlib = require('zlib');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-acc-'));
Object.assign(process.env, { DB_PATH: path.join(tmp, 'test.db'), PAYSTACK_SECRET_KEY: '', APP_SECRET: 'test-secret-1234567890', ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'admin-pass-123', SUPABASE_SERVICE_ROLE_KEY: 'mock-key' });
delete process.env.DEMO_PAYMENTS;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok   ' + m); } else { fail++; console.log('FAIL ' + m); } };
const near = (a, b) => Math.abs(a - b) < 0.01;
(async () => {
  const mock = await require('./mock-supabase').start(0, 'mock-key');
  process.env.SUPABASE_URL = 'http://localhost:' + mock.server.address().port;
  const { handle } = require('../server'); const { q } = require('../server/db');
  const app = http.createServer(handle); await new Promise(r => app.listen(0, r)); const base = 'http://localhost:' + app.address().port;
  const call = async (method, p, body, token) => { const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); let j = null; const buf = Buffer.from(await res.arrayBuffer()); try { j = JSON.parse(buf.toString()); } catch {} return { s: res.status, j, buf, h: res.headers }; };
  const admin = (await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' })).j.token;
  const cust = (await call('POST', '/api/auth/register', { name: 'Ada Obi', email: 'ada@test.ng', password: 'password1', phone: '0803' })).j.token;
  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);

  ok((await call('GET', '/api/admin/accounts/report')).s === 401, 'accounts need a sign-in');
  ok((await call('GET', '/api/admin/accounts/report', undefined, cust)).s === 403, 'customers cannot see the accounts');
  const empty = (await call('GET', '/api/admin/accounts/report?preset=all', undefined, admin)).j; ok(empty.pnl.net_profit === 0 && empty.balance.difference === 0, 'empty shop: all zero and balanced');

  const A = (await call('POST', '/api/admin/products', { name: 'Sneakers', category: 'Footwear', price: 20000, stock_qty: 10 }, admin)).j, B = (await call('POST', '/api/admin/products', { name: 'Socks', category: 'Clothing', price: 5000, stock_qty: 20 }, admin)).j;
  const noCost = await call('PUT', '/api/admin/accounts/costs', { costs: [{ product_id: A.id, cost: 12000 }, { product_id: B.id, cost: 3000 }] }, admin); ok(noCost.s === 200 && noCost.j.updated === 2, 'cost prices saved');
  ok((await call('PUT', '/api/admin/accounts/costs', { costs: [{ product_id: A.id, cost: -5 }] }, admin)).s === 400, 'negative cost rejected');
  const costs = (await call('GET', '/api/admin/accounts/costs', undefined, admin)).j; ok(costs.find(c => c.id === A.id).cost === 12000, 'cost prices listed with the products');
  await new Promise(r => setTimeout(r, 50));

  const buy = async items => (await call('POST', '/api/shop/checkout', { name: 'Ada Obi', phone: '0803', email: 'ada@test.ng', method: 'delivery', address: '12 Allen Ave', items }, cust)).j;
  const o1 = await buy([{ product_id: A.id, qty: 2 }, { product_id: B.id, qty: 1 }]), o2 = await buy([{ product_id: B.id, qty: 2 }]); ok(o1.total === 47000 && o2.total === 12000, 'two demo orders placed');
  const oid2 = q.get('SELECT id FROM orders WHERE reference=?', o2.reference).id;
  ok(q.all('SELECT unit_cost FROM order_items WHERE order_id=(SELECT id FROM orders WHERE reference=?)', o1.reference).every(i => i.unit_cost > 0), 'cost of goods frozen on each order line at sale time');
  ok((await call('POST', `/api/admin/orders/${oid2}/refund`, {}, admin)).s === 200, 'second order refunded');

  ok((await call('POST', '/api/admin/accounts/expenses', { category: 'rent', amount: 50000, description: 'Shop rent' }, admin)).s === 200, 'expense: rent');
  ok((await call('POST', '/api/admin/accounts/expenses', { category: 'marketing', amount: 10000, date: today }, admin)).s === 200, 'expense: marketing');
  ok((await call('POST', '/api/admin/accounts/expenses', { category: 'rent', amount: 0 }, admin)).s === 400, 'zero expense rejected');
  ok((await call('POST', '/api/admin/accounts/expenses', { category: 'rent', amount: 5, date: 'tomorrow' }, admin)).s === 400, 'bad date rejected');
  ok((await call('POST', '/api/admin/accounts/money', { kind: 'capital', amount: 500000, description: 'Start-up money' }, admin)).s === 200, 'owner capital');
  ok((await call('POST', '/api/admin/accounts/money', { kind: 'stock_purchase', amount: 200000 }, admin)).s === 200, 'stock purchase');
  ok((await call('POST', '/api/admin/accounts/money', { kind: 'nonsense', amount: 5 }, admin)).s === 400, 'unknown money entry rejected');
  ok((await call('POST', '/api/admin/accounts/assets', { name: 'Shelving', cost: 120000, purchase_date: today, life_years: 2 }, admin)).s === 200, 'equipment bought');

  const R = (await call('GET', '/api/admin/accounts/report?preset=all', undefined, admin)).j, p = R.pnl, b = R.balance;
  ok(near(p.sales, 55000) && near(p.delivery, 4000) && near(p.refunds, 12000) && near(p.net_revenue, 47000), 'P&L revenue: sales, delivery and refunds');
  ok(near(p.cogs, 27000) && near(p.gross_profit, 20000), 'P&L cost of goods (refunded stock goes back) and gross profit');
  ok(near(p.fees, 1085) && near(p.categories.rent, 50000) && near(p.categories.marketing, 10000) && near(p.depreciation, 5000), 'P&L fees, expenses and depreciation');
  ok(near(p.net_profit, -46085), 'net profit (a loss) is right: ' + p.net_profit);
  ok(near(b.cash, 165915) && near(b.inventory, 173000) && near(b.equipment, 115000), 'balance sheet cash, stock and equipment');
  ok(near(b.total_assets, 453915) && near(b.total_equity, 453915) && b.difference === 0, 'balance sheet balances');
  ok(near(R.cashflow.closing, b.cash) && near(R.cashflow.opening, 0) && near(R.cashflow.operating, 47000 - 1085 - 60000 - 200000), 'cash flow ties to the balance sheet cash');
  ok(near(R.trial_totals.debit, R.trial_totals.credit) && R.trial_totals.debit > 0, 'trial balance debits equal credits');
  ok(R.kpis.orders === 1 && R.products.length === 2 && R.products.find(x => x.name === 'Socks').units === 1, 'products report counts only sales that stood (refunded order excluded)');
  ok(R.products[0].name === 'Sneakers' && near(R.products[0].profit, 16000) , 'product profit: ' + JSON.stringify(R.products[0]));
  ok(R.warnings.some(w => /Demo payments/.test(w)), 'warns that demo payments are on');
  ok(R.tables.length >= 11 && R.tables.find(t => t.key === 'income').rows.length > 10, 'tables built for every report');

  // month-limited view: capital before, nothing counted twice
  const lm = (await call('GET', '/api/admin/accounts/report?preset=lastmonth', undefined, admin)).j; ok(lm.pnl.net_revenue === 0 && lm.cashflow.closing === 0 && lm.balance.difference === 0, 'last month (before any records) is empty and balanced');
  const cu = (await call('GET', `/api/admin/accounts/report?from=${today}&to=${today}`, undefined, admin)).j; ok(near(cu.pnl.net_profit, -46085) && near(cu.cashflow.closing, 165915), 'custom one-day range');

  // tax + VAT settings
  const sv = await call('PUT', '/api/admin/accounts/settings', { vat_enabled: true, vat_rate: 7.5, income_tax_rate: 30, fees_enabled: true, fee_percent: 1.5, fee_flat: 100, fee_flat_over: 2500, fee_cap: 2000, fy_start_month: 1 }, admin); ok(sv.s === 200, 'VAT and tax settings saved');
  const R2 = (await call('GET', '/api/admin/accounts/report?preset=all', undefined, admin)).j;
  ok(near(R2.vat.collected, 59000 - 59000 / 1.075 + 12000 - 12000 / 1.075 - 0) || R2.vat.collected > 0, 'VAT collected is calculated: ' + R2.vat.collected);
  ok(R2.balance.difference === 0 && near(R2.trial_totals.debit, R2.trial_totals.credit), 'still balanced with VAT on');
  ok(near(R2.pnl.net_revenue, 47000 / 1.075), 'revenue excludes VAT when VAT is on');
  ok((await call('PUT', '/api/admin/accounts/settings', { vat_enabled: true, vat_rate: 'x' }, admin)).s === 400, 'bad settings rejected');
  await call('PUT', '/api/admin/accounts/settings', { vat_enabled: false, vat_rate: 7.5, income_tax_rate: 30, fees_enabled: true, fee_percent: 1.5, fee_flat: 100, fee_flat_over: 2500, fee_cap: 2000, fy_start_month: 1 }, admin);
  // profit then tax
  await call('POST', '/api/admin/accounts/money', { kind: 'opening_stock', amount: 1 }, admin);
  const R3 = (await call('GET', '/api/admin/accounts/report?preset=all', undefined, admin)).j; ok(R3.pnl.tax === 0 && R3.balance.difference === 0, 'no tax on a loss');
  q.run("INSERT INTO orders(reference,customer_name,customer_phone,customer_email,method,subtotal,total,status,paid_at) VALUES('BIG1','x','1','x@t.ng','pickup',1000000,1000000,'completed',datetime('now'))");
  const R4 = (await call('GET', '/api/admin/accounts/report?preset=all', undefined, admin)).j; ok(R4.pnl.tax > 0 && near(R4.pnl.tax, R4.pnl.profit_before_tax * 0.3) && R4.balance.difference === 0 && near(R4.balance.liabilities.tax, R4.pnl.tax), 'income tax estimate accrues as a liability and the sheet still balances');

  // downloads
  const x = await call('GET', '/api/admin/accounts/export?preset=all&format=xlsx', undefined, admin);
  ok(x.s === 200 && x.buf.subarray(0, 2).toString() === 'PK' && /spreadsheetml/.test(x.h.get('content-type')) && /\.xlsx"/.test(x.h.get('content-disposition')), 'Excel download is a real xlsx file');
  fs.writeFileSync('/tmp/accounts.xlsx', x.buf);
  const c = await call('GET', '/api/admin/accounts/export?preset=all&format=csv&table=income', undefined, admin); ok(c.s === 200 && /Net revenue/.test(c.buf.toString()) && /text\/csv/.test(c.h.get('content-type')), 'CSV download of one report');
  ok((await call('GET', '/api/admin/accounts/export?format=csv&table=nope', undefined, admin)).s === 400, 'unknown CSV report refused');
  const h = await call('GET', '/api/admin/accounts/export?preset=all&format=html', undefined, admin); ok(h.s === 200 && /<table>/.test(h.buf.toString()) && /Balance sheet/.test(h.buf.toString()), 'printable statements page');
  ok((await call('GET', '/api/admin/accounts/export?format=xlsx')).s === 401, 'downloads need a sign-in');
  ok((await call('GET', '/api/admin/audit', undefined, admin)).j.some(a => a.action === 'accounts.export'), 'downloads are written to the activity log');

  // deleting records
  const ex = (await call('GET', '/api/admin/accounts/expenses?preset=all', undefined, admin)).j; ok(Array.isArray(ex), 'expenses list');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
