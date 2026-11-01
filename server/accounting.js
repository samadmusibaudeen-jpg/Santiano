// Accounting engine. Everything is derived from a double-entry journal that is rebuilt from the shop's own records
// (paid orders, refunds, expenses, owner money, stock purchases, equipment), so the statements always agree with each other
// and the trial balance always balances.
const { q, getSetting, setSetting } = require('./db');
const cfg = require('./config');
const catalog = require('./catalog');

const r2 = n => Math.round((+n + Number.EPSILON) * 100) / 100;
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
// Shop timestamps are UTC; Nigeria is UTC+1, so a sale at 11:30pm belongs to the next day's books.
const wat = ts => { const t = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z')).getTime(); return Number.isFinite(t) ? ymd(new Date(t + 3600e3)) : String(ts).slice(0, 10); };
const today = () => ymd(new Date(Date.now() + 3600e3));
const monthEnd = (y, m) => ymd(new Date(Date.UTC(y, m, 0)));
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400e3);

const EXP_CATS = { rent: 'Rent', salaries: 'Salaries & wages', marketing: 'Marketing & advertising', packaging: 'Packaging', delivery: 'Delivery & logistics', utilities: 'Utilities & power',
  software: 'Internet & software', transport: 'Transport & travel', repairs: 'Repairs & maintenance', bank: 'Bank & finance charges', other: 'Other expenses' };
const EXP_CODE = {}; Object.keys(EXP_CATS).forEach((k, i) => { EXP_CODE[k] = 6010 + i * 10; });
const MONEY_KINDS = { capital: 'Owner put money in', drawing: 'Owner took money out', loan_in: 'Loan received', loan_repay: 'Loan repaid (principal)', stock_purchase: 'Stock bought', opening_stock: 'Opening stock (already owned)' };
const ACCT = { 1000: ['Cash & bank', 'asset'], 1100: ['Inventory (stock at cost)', 'asset'], 1500: ['Equipment (at cost)', 'asset'], 1510: ['Accumulated depreciation', 'asset'],
  2000: ['VAT payable', 'liability'], 2100: ['Loans payable', 'liability'], 2200: ['Income tax payable', 'liability'],
  3000: ["Owner's capital", 'equity'], 3100: ["Owner's drawings", 'equity'],
  4000: ['Sales of goods', 'revenue'], 4100: ['Delivery income', 'revenue'], 4900: ['Discounts given', 'revenue'], 4950: ['Refunds & returns', 'revenue'],
  5000: ['Cost of goods sold', 'expense'], 5100: ['Payment processing fees', 'expense'], 6900: ['Depreciation', 'expense'], 7000: ['Income tax expense', 'expense'] };
for (const [k, c] of Object.entries(EXP_CODE)) ACCT[c] = [EXP_CATS[k], 'expense'];

const DEFAULTS = { vat_enabled: false, vat_rate: 7.5, income_tax_rate: 0, fees_enabled: true, fee_percent: 1.5, fee_flat: 100, fee_flat_over: 2500, fee_cap: 2000, fy_start_month: 1 };
const settings = () => ({ ...DEFAULTS, ...(getSetting('accounting', {}) || {}) });
const saveSettings = s => setSetting('accounting', s);

function feeFor(total, S) {
  if (!S.fees_enabled) return 0;
  let f = total * S.fee_percent / 100 + (total >= S.fee_flat_over ? S.fee_flat : 0);
  if (S.fee_cap > 0) f = Math.min(f, S.fee_cap);
  return r2(f);
}

// Money figures for one paid order (VAT is treated as included in the shelf price).
function orderFigures(o, items, S, costs) {
  const k = S.vat_enabled ? 1 / (1 + S.vat_rate / 100) : 1;
  const rev = r2(o.subtotal * k), disc = r2(o.discount * k), del = r2(o.delivery_fee * k), vat = r2(o.total - (rev - disc + del));
  let cogs = 0; const lines = [], missing = [];
  for (const it of items) {
    const known = it.unit_cost != null ? it.unit_cost : (it.product_id != null && costs.has(it.product_id) ? costs.get(it.product_id) : null);
    if (known == null) missing.push(it.name);
    const cost = r2((known || 0) * it.qty), gross = it.qty * it.unit_price, share = o.subtotal > 0 ? gross / o.subtotal : 0;
    cogs += cost; lines.push({ product_id: it.product_id, name: it.name, qty: it.qty, revenue: r2((gross - o.discount * share) * k), cost, costKnown: known != null });
  }
  return { rev, disc, del, vat, total: o.total, net: r2(rev - disc + del), cogs: r2(cogs), fee: feeFor(o.total, S), lines, missing };
}

function buildJournal(S) {
  const J = [], tdy = today();
  const add = (date, source, ref, memo, lines) => J.push({ date, source, ref, memo, lines: lines.filter(l => l[1] || l[2]).map(([a, dr, cr]) => ({ a, dr: r2(dr || 0), cr: r2(cr || 0) })) });
  const costs = new Map(q.all('SELECT product_id, cost FROM product_costs').map(r => [r.product_id, r.cost]));
  const itemsBy = new Map();
  for (const it of q.all('SELECT * FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE paid_at IS NOT NULL)')) { if (!itemsBy.has(it.order_id)) itemsBy.set(it.order_id, []); itemsBy.get(it.order_id).push(it); }
  const refundAt = new Map(q.all("SELECT detail, MAX(created_at) at FROM audit_log WHERE action='order.refund' GROUP BY detail").map(r => [r.detail, r.at]));
  const orders = [];
  for (const o of q.all("SELECT * FROM orders WHERE paid_at IS NOT NULL AND status IN ('paid','processing','ready','dispatched','completed','refunded') ORDER BY id")) {
    const f = orderFigures(o, itemsBy.get(o.id) || [], S, costs), d = wat(o.paid_at); orders.push({ o, f, date: d });
    add(d, 'sale', o.reference, `Sale ${o.reference}`, [[1000, o.total, 0], [4900, f.disc, 0], [4000, 0, f.rev], [4100, 0, f.del], [2000, 0, f.vat]]);
    if (f.fee) add(d, 'fee', o.reference, `Payment fee ${o.reference}`, [[5100, f.fee, 0], [1000, 0, f.fee]]);
    if (f.cogs) add(d, 'cogs', o.reference, `Cost of goods ${o.reference}`, [[5000, f.cogs, 0], [1100, 0, f.cogs]]);
    if (o.status === 'refunded') {
      const rd = refundAt.has(o.reference) ? wat(refundAt.get(o.reference)) : d;
      add(rd, 'refund', o.reference, `Refund ${o.reference}`, [[4950, f.net, 0], [2000, f.vat, 0], [1000, 0, o.total]]);
      if (f.cogs) add(rd, 'cogs', o.reference, `Stock returned ${o.reference}`, [[1100, f.cogs, 0], [5000, 0, f.cogs]]);
    }
  }
  for (const e of q.all('SELECT * FROM expenses ORDER BY date, id')) {
    const c = EXP_CODE[e.category] || EXP_CODE.other;
    add(e.date, 'expense', 'EXP-' + e.id, `${EXP_CATS[e.category] || 'Other'}${e.description ? ': ' + e.description : ''}`, [[c, e.amount, 0], [1000, 0, e.amount]]);
  }
  for (const m of q.all('SELECT * FROM money_entries ORDER BY date, id')) {
    const ref = 'MON-' + m.id, memo = m.description || MONEY_KINDS[m.kind] || m.kind, a = m.amount;
    if (m.kind === 'capital') add(m.date, 'capital', ref, memo, [[1000, a, 0], [3000, 0, a]]);
    else if (m.kind === 'drawing') add(m.date, 'drawing', ref, memo, [[3100, a, 0], [1000, 0, a]]);
    else if (m.kind === 'loan_in') add(m.date, 'loan', ref, memo, [[1000, a, 0], [2100, 0, a]]);
    else if (m.kind === 'loan_repay') add(m.date, 'loan', ref, memo, [[2100, a, 0], [1000, 0, a]]);
    else if (m.kind === 'stock_purchase') add(m.date, 'stock', ref, memo, [[1100, a, 0], [1000, 0, a]]);
    else if (m.kind === 'opening_stock') add(m.date, 'opening', ref, memo, [[1100, a, 0], [3000, 0, a]]);
  }
  const assets = q.all('SELECT * FROM fixed_assets ORDER BY purchase_date, id');
  for (const a of assets) {
    add(a.purchase_date, 'asset', 'AST-' + a.id, `Bought ${a.name}`, [[1500, a.cost, 0], [1000, 0, a.cost]]);
    const monthly = (a.cost - a.salvage) / (a.life_years * 12), months = Math.round(a.life_years * 12);
    let y = +a.purchase_date.slice(0, 4), m = +a.purchase_date.slice(5, 7), done = 0;
    while (done < months && monthEnd(y, m) <= monthEnd(+tdy.slice(0, 4), +tdy.slice(5, 7))) {
      const me = monthEnd(y, m), amt = done === months - 1 ? r2(a.cost - a.salvage - r2(monthly) * done) : r2(monthly);
      add(me > tdy ? tdy : me, 'depreciation', 'AST-' + a.id, `Depreciation: ${a.name}`, [[6900, amt, 0], [1510, 0, amt]]);
      done++; m++; if (m > 12) { m = 1; y++; }
    }
  }
  J.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { J, orders, costs };
}

const bal = (entries, acct) => { let t = 0; for (const e of entries) for (const l of e.lines) if (l.a === acct) t += l.dr - l.cr; return r2(t); };
const balRange = (entries, lo, hi) => { let t = 0; for (const e of entries) for (const l of e.lines) if (l.a >= lo && l.a <= hi) t += l.dr - l.cr; return r2(t); };

function resolvePeriod(query, S) {
  const t = today(), y = +t.slice(0, 4), m = +t.slice(5, 7), p = query.preset || 'month';
  const first = (yy, mm) => `${yy}-${pad(mm)}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(query.from || '') && /^\d{4}-\d{2}-\d{2}$/.test(query.to || '')) return { from: query.from, to: query.to < query.from ? query.from : query.to, preset: 'custom' };
  if (p === 'lastmonth') { const yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1; return { from: first(yy, mm), to: monthEnd(yy, mm), preset: p }; }
  if (p === 'quarter') { const qs = Math.floor((m - 1) / 3) * 3 + 1; return { from: first(y, qs), to: t, preset: p }; }
  if (p === 'year') return { from: first(y, 1), to: t, preset: p };
  if (p === 'fy') { const fm = S.fy_start_month || 1, sy = m >= fm ? y : y - 1; return { from: first(sy, fm), to: t, preset: p }; }
  if (p === 'all') return { from: '2000-01-01', to: t, preset: p };
  return { from: first(y, m), to: t, preset: 'month' };
}

async function compute(period) {
  const S = settings(), { J, orders, costs } = buildJournal(S), { from, to } = period, tdy = today();
  const P = J.filter(e => e.date >= from && e.date <= to), before = J.filter(e => e.date < from), upto = J.filter(e => e.date <= to);

  // ---- income statement ----
  const sales = -bal(P, 4000), delivery = -bal(P, 4100), discounts = bal(P, 4900), refunds = bal(P, 4950);
  const netRevenue = r2(sales + delivery - discounts - refunds), cogs = bal(P, 5000), gross = r2(netRevenue - cogs);
  const fees = bal(P, 5100), dep = bal(P, 6900), cats = {};
  for (const [k, c] of Object.entries(EXP_CODE)) { const v = bal(P, c); if (v) cats[k] = v; }
  const opex = r2(fees + dep + Object.values(cats).reduce((a, b) => a + b, 0)), pbt = r2(gross - opex);
  const tax = pbt > 0 && S.income_tax_rate > 0 ? r2(pbt * S.income_tax_rate / 100) : 0, netProfit = r2(pbt - tax);
  const pnl = { sales, delivery, discounts, refunds, net_revenue: netRevenue, cogs, gross_profit: gross, fees, depreciation: dep, categories: cats, operating_expenses: opex, profit_before_tax: pbt, tax, net_profit: netProfit };

  // ---- balance sheet (as at `to`, everything from the first record; estimated tax for the period is accrued as owed) ----
  const A = tax ? [...upto, { date: to, source: 'tax', lines: [{ a: 7000, dr: tax, cr: 0 }, { a: 2200, dr: 0, cr: tax }] }] : upto;
  const cash = bal(A, 1000), inventory = bal(A, 1100), equipment = r2(bal(A, 1500) + bal(A, 1510)), totalAssets = r2(cash + inventory + equipment);
  const liab = { vat: -bal(A, 2000), loans: -bal(A, 2100), tax: -bal(A, 2200) }, totalLiab = r2(liab.vat + liab.loans + liab.tax);
  const retained = -balRange(A, 4000, 7999), capital = -bal(A, 3000), drawings = -bal(A, 3100), totalEquity = r2(capital + drawings + retained);
  const balance = { cash, inventory, equipment, equipment_cost: bal(A, 1500), accumulated_depreciation: -bal(A, 1510), total_assets: totalAssets, liabilities: liab, total_liabilities: totalLiab, capital, drawings, retained_earnings: r2(retained), total_equity: totalEquity, difference: r2(totalAssets - totalLiab - totalEquity) };

  // ---- cash flow (direct method) ----
  const cf = {}; for (const e of P) { const d = e.lines.reduce((t, l) => t + (l.a === 1000 ? l.dr - l.cr : 0), 0); if (d) cf[e.source] = r2((cf[e.source] || 0) + d); }
  const g = k => cf[k] || 0, opening = bal(before, 1000);
  const operating = r2(g('sale') + g('refund') + g('fee') + g('expense') + g('stock')), investing = g('asset'), financing = r2(g('capital') + g('drawing') + g('loan'));
  const cashflow = { receipts: g('sale'), refunds: g('refund'), fees: g('fee'), expenses: g('expense'), stock: g('stock'), operating, investing, capital: g('capital'), loans: g('loan'), drawings: g('drawing'), financing, net: r2(operating + investing + financing), opening, closing: r2(opening + operating + investing + financing) };

  // ---- trial balance ----
  const trial = Object.keys(ACCT).map(Number).sort().map(a => { const b = bal(A, a); return { code: a, name: ACCT[a][0], debit: b > 0 ? b : 0, credit: b < 0 ? -b : 0 }; }).filter(x => x.debit || x.credit);

  // ---- monthly trend ----
  const mon = new Map(); const bump = (k, f, v) => { if (!mon.has(k)) mon.set(k, { month: k, revenue: 0, cogs: 0, expenses: 0 }); mon.get(k)[f] += v; };
  for (const e of P) for (const l of e.lines) { const k = e.date.slice(0, 7); if (l.a >= 4000 && l.a < 5000) bump(k, 'revenue', l.cr - l.dr); else if (l.a === 5000) bump(k, 'cogs', l.dr - l.cr); else if (l.a >= 5100 && l.a < 7000) bump(k, 'expenses', l.dr - l.cr); }
  const monthly = [...mon.values()].sort((a, b) => a.month < b.month ? -1 : 1).slice(-24).map(m => ({ ...m, revenue: r2(m.revenue), cogs: r2(m.cogs), expenses: r2(m.expenses), profit: r2(m.revenue - m.cogs - m.expenses) }));

  // ---- products & categories (paid orders in the period that are still sold) ----
  let rows = [], catalogOk = false; try { rows = (await catalog.ensure()).rows; catalogOk = true; } catch {}
  const byId = new Map(rows.map(r => [r.id, r])), prod = new Map(), missing = new Set(); let orderCount = 0, receipts = 0;
  for (const { o, f, date } of orders) {
    if (date < from || date > to || o.status === 'refunded') continue;
    orderCount++; receipts += o.total; f.missing.forEach(n => missing.add(n));
    for (const l of f.lines) { const key = l.product_id != null ? l.product_id : 'n:' + l.name; if (!prod.has(key)) prod.set(key, { name: l.name, category: (byId.get(l.product_id) || {}).category || 'Uncategorised', units: 0, revenue: 0, cost: 0, costKnown: true }); const p = prod.get(key); p.units += l.qty; p.revenue += l.revenue; p.cost += l.cost; p.costKnown = p.costKnown && l.costKnown; }
  }
  const products = [...prod.values()].map(p => ({ ...p, revenue: r2(p.revenue), cost: r2(p.cost), profit: r2(p.revenue - p.cost), margin: p.revenue > 0 ? r2((p.revenue - p.cost) / p.revenue * 100) : null })).sort((a, b) => b.profit - a.profit);
  const cm = new Map(); for (const p of products) { const c = cm.get(p.category) || { category: p.category, units: 0, revenue: 0, cost: 0 }; c.units += p.units; c.revenue += p.revenue; c.cost += p.cost; cm.set(p.category, c); }
  const categories = [...cm.values()].map(c => ({ ...c, revenue: r2(c.revenue), cost: r2(c.cost), profit: r2(c.revenue - c.cost), margin: c.revenue > 0 ? r2((c.revenue - c.cost) / c.revenue * 100) : null })).sort((a, b) => b.profit - a.profit);

  // ---- stock on hand valued at cost ----
  const stock = rows.filter(p => p.stock_qty != null && p.stock_qty > 0).map(p => { const c = costs.has(p.id) ? costs.get(p.id) : null; return { id: p.id, name: p.name, category: p.category || 'Uncategorised', qty: p.stock_qty, cost: c, value: c == null ? null : r2(c * p.stock_qty), price: p.price, retail: r2((p.price || 0) * p.stock_qty), potential: c == null ? null : r2((p.price || 0) * p.stock_qty - c * p.stock_qty) }; }).sort((a, b) => (b.value || 0) - (a.value || 0));
  const stockValue = r2(stock.reduce((t, s) => t + (s.value || 0), 0)), stockRetail = r2(stock.reduce((t, s) => t + s.retail, 0)), stockNoCost = stock.filter(s => s.cost == null).length;

  // ---- VAT ----
  const vat = { enabled: S.vat_enabled, rate: S.vat_rate, balance: liab.vat };
  const vatIn = -P.reduce((t, e) => t + (e.source === 'sale' ? e.lines.reduce((x, l) => x + (l.a === 2000 ? l.dr - l.cr : 0), 0) : 0), 0), vatOut = P.reduce((t, e) => t + (e.source === 'refund' ? e.lines.reduce((x, l) => x + (l.a === 2000 ? l.dr : 0), 0) : 0), 0);
  vat.collected = r2(vatIn); vat.refunded = r2(vatOut); vat.net_due = r2(vatIn - vatOut);

  // ---- ratios ----
  const days = Math.max(1, daysBetween(from < '2001-01-01' ? (J[0] ? J[0].date : to) : from, to) + 1), months = Math.max(1, days / 30.44);
  const variable = cogs + fees, cmRatio = netRevenue > 0 ? (netRevenue - variable) / netRevenue : null, fixedMonthly = (opex - fees) / months;
  const avgInv = (bal(before, 1100) + inventory) / 2, turnover = avgInv > 0 ? cogs / avgInv : null;
  const kpis = { orders: orderCount, avg_order: orderCount ? r2(receipts / orderCount) : null, gross_margin: netRevenue > 0 ? r2(gross / netRevenue * 100) : null, net_margin: netRevenue > 0 ? r2(netProfit / netRevenue * 100) : null,
    expense_ratio: netRevenue > 0 ? r2(opex / netRevenue * 100) : null, break_even_monthly: cmRatio > 0 ? r2(fixedMonthly / cmRatio) : null, fixed_costs_monthly: r2(fixedMonthly), contribution_margin: cmRatio != null ? r2(cmRatio * 100) : null,
    inventory_turnover: turnover != null ? r2(turnover) : null, days_in_stock: turnover > 0 ? Math.round(days / turnover) : null, liquidity_ratio: totalLiab > 0 ? r2((cash + inventory) / totalLiab) : null, period_days: days };

  // ---- warnings ----
  const warnings = [];
  if (cfg.demoPayments && !cfg.paystackKey && orderCount) warnings.push('Demo payments are ON, so these sales were not real money. Connect Paystack before relying on these figures.');
  if (missing.size) warnings.push(`${missing.size} product${missing.size > 1 ? 's were' : ' was'} sold with no cost price (${[...missing].slice(0, 4).join(', ')}${missing.size > 4 ? '…' : ''}). Profit is overstated until you fill in the Cost prices tab.`);
  if (cash < 0) warnings.push('Cash is below zero. This usually means money you started with, or stock you bought, has not been recorded yet. Add it under Owner & stock.');
  if (catalogOk && Math.abs(inventory - stockValue) > 1 && (inventory || stockValue)) warnings.push(`Stock in the books is ₦${Math.round(inventory).toLocaleString('en-NG')} but the stock on hand, valued at cost, is ₦${Math.round(stockValue).toLocaleString('en-NG')}. Record stock purchases or opening stock so the two agree.`);
  if (Math.abs(balance.difference) > 0.05) warnings.push('The balance sheet is out of balance by ₦' + balance.difference + '. Please report this.');

  return { period: { from, to, preset: period.preset }, as_of: tdy, settings: S, pnl, balance, cashflow, trial, trial_totals: { debit: r2(trial.reduce((t, x) => t + x.debit, 0)), credit: r2(trial.reduce((t, x) => t + x.credit, 0)) },
    monthly, products, categories, stock, stock_summary: { value: stockValue, retail: stockRetail, potential: r2(stockRetail - stockValue), without_cost: stockNoCost, catalogue_connected: catalogOk }, vat, kpis, warnings,
    journal: P.map(e => ({ date: e.date, ref: e.ref, memo: e.memo, source: e.source, lines: e.lines })) };
}

// ---------- tables (shared by the screen, Excel, CSV and print) ----------
const pct = v => v == null ? '–' : v.toFixed(1) + '%';
function tables(R) {
  const p = R.pnl, b = R.balance, c = R.cashflow, S = R.settings, per = `${R.period.from} to ${R.period.to}`, row = (cells, o = {}) => ({ c: cells, ...o });
  const T = [];
  T.push({ key: 'income', title: 'Profit & Loss (income statement)', sub: per, cols: ['Item', '₦'], rows: [
    row(['Revenue'], { h: 1 }), row(['Sales of goods', p.sales], { i: 1 }), row(['Delivery income', p.delivery], { i: 1 }), row(['Less: discounts given', -p.discounts], { i: 1 }), row(['Less: refunds & returns', -p.refunds], { i: 1 }),
    row(['Net revenue', p.net_revenue], { b: 1 }), row(['Cost of goods sold', -p.cogs]), row(['Gross profit', p.gross_profit], { b: 1 }), row(['Gross margin', pct(R.kpis.gross_margin)], { i: 1 }),
    row(['Operating expenses'], { h: 1 }), row(['Payment processing fees', -p.fees], { i: 1 }),
    ...Object.entries(p.categories).map(([k, v]) => row([EXP_CATS[k], -v], { i: 1 })), row(['Depreciation of equipment', -p.depreciation], { i: 1 }),
    row(['Total operating expenses', -p.operating_expenses], { b: 1 }), row(['Profit before tax', p.profit_before_tax], { b: 1 }), row([`Income tax (estimate at ${S.income_tax_rate}%)`, -p.tax]), row(['NET PROFIT', p.net_profit], { b: 1, h: 1 }), row(['Net margin', pct(R.kpis.net_margin)], { i: 1 })] });
  T.push({ key: 'balance', title: 'Balance sheet', sub: `As at ${R.period.to}`, cols: ['Item', '₦'], rows: [
    row(['Assets'], { h: 1 }), row(['Cash & bank', b.cash], { i: 1 }), row(['Inventory (stock at cost)', b.inventory], { i: 1 }), row(['Equipment (cost ' + b.equipment_cost.toLocaleString('en-NG') + ' less depreciation)', b.equipment], { i: 1 }), row(['Total assets', b.total_assets], { b: 1 }),
    row(['Liabilities (what the shop owes)'], { h: 1 }), row(['VAT payable', b.liabilities.vat], { i: 1 }), row(['Loans', b.liabilities.loans], { i: 1 }), row(['Income tax payable (estimate)', b.liabilities.tax], { i: 1 }), row(['Total liabilities', b.total_liabilities], { b: 1 }),
    row(["Owner's equity"], { h: 1 }), row(["Owner's capital", b.capital], { i: 1 }), row(["Less: owner's drawings", b.drawings], { i: 1 }), row(['Profit kept in the business (retained earnings)', b.retained_earnings], { i: 1 }), row(["Total owner's equity", b.total_equity], { b: 1 }),
    row(['Total liabilities + equity', r2(b.total_liabilities + b.total_equity)], { b: 1 })] });
  T.push({ key: 'cashflow', title: 'Cash flow statement', sub: per, cols: ['Item', '₦'], rows: [
    row(['Operating activities'], { h: 1 }), row(['Received from customers', c.receipts], { i: 1 }), row(['Refunds paid', c.refunds], { i: 1 }), row(['Payment processing fees', c.fees], { i: 1 }), row(['Expenses paid', c.expenses], { i: 1 }), row(['Stock bought', c.stock], { i: 1 }), row(['Net cash from operations', c.operating], { b: 1 }),
    row(['Investing activities'], { h: 1 }), row(['Equipment bought', c.investing], { i: 1 }),
    row(['Financing activities'], { h: 1 }), row(['Owner put in', c.capital], { i: 1 }), row(['Loans received / (repaid)', c.loans], { i: 1 }), row(["Owner's drawings", c.drawings], { i: 1 }), row(['Net cash from financing', c.financing], { b: 1 }),
    row(['Net change in cash', c.net], { b: 1 }), row(['Cash at start of period', c.opening]), row(['CASH AT END OF PERIOD', c.closing], { b: 1, h: 1 })] });
  T.push({ key: 'trial', title: 'Trial balance', sub: `As at ${R.period.to}, from the first record`, cols: ['Code', 'Account', 'Debit ₦', 'Credit ₦'], rows: [
    ...R.trial.map(x => row([x.code, x.name, x.debit || null, x.credit || null])), row(['', 'TOTAL', R.trial_totals.debit, R.trial_totals.credit], { b: 1 })] });
  T.push({ key: 'products', title: 'Profit by product', sub: per, cols: ['Product', 'Category', 'Units sold', 'Revenue ₦', 'Cost ₦', 'Profit ₦', 'Margin'], rows: [
    ...R.products.map(x => row([x.name + (x.costKnown ? '' : ' (no cost price)'), x.category, x.units, x.revenue, x.cost, x.profit, pct(x.margin)])),
    row(['TOTAL', '', R.products.reduce((t, x) => t + x.units, 0), r2(R.products.reduce((t, x) => t + x.revenue, 0)), r2(R.products.reduce((t, x) => t + x.cost, 0)), r2(R.products.reduce((t, x) => t + x.profit, 0)), ''], { b: 1 })] });
  T.push({ key: 'categories', title: 'Profit by category', sub: per, cols: ['Category', 'Units sold', 'Revenue ₦', 'Cost ₦', 'Profit ₦', 'Margin'], rows: R.categories.map(x => row([x.category, x.units, x.revenue, x.cost, x.profit, pct(x.margin)])) });
  T.push({ key: 'stock', title: 'Stock on hand (valued at cost)', sub: `As at ${R.as_of}`, cols: ['Product', 'Category', 'In stock', 'Unit cost ₦', 'Value at cost ₦', 'Selling price ₦', 'Value at selling price ₦', 'Potential profit ₦'], rows: [
    ...R.stock.map(x => row([x.name, x.category, x.qty, x.cost, x.value, x.price, x.retail, x.potential])), row(['TOTAL', '', '', '', R.stock_summary.value, '', R.stock_summary.retail, R.stock_summary.potential], { b: 1 })] });
  const totalExp = p.operating_expenses;
  T.push({ key: 'expenses', title: 'Expenses by category', sub: per, cols: ['Category', '₦', '% of expenses'], rows: [
    ...[['Payment processing fees', p.fees], ...Object.entries(p.categories).map(([k, v]) => [EXP_CATS[k], v]), ['Depreciation', p.depreciation]].filter(x => x[1]).sort((a, b) => b[1] - a[1]).map(([n, v]) => row([n, v, pct(totalExp ? v / totalExp * 100 : null)])), row(['TOTAL', totalExp, ''], { b: 1 })] });
  T.push({ key: 'monthly', title: 'Month by month', sub: per, cols: ['Month', 'Net revenue ₦', 'Cost of goods ₦', 'Expenses ₦', 'Profit before tax ₦'], rows: R.monthly.map(m => row([m.month, m.revenue, m.cogs, m.expenses, m.profit])) });
  T.push({ key: 'vat', title: 'VAT summary', sub: `${per} · VAT ${S.vat_enabled ? 'on at ' + S.vat_rate + '%' : 'is switched off'}`, cols: ['Item', '₦'], rows: [row(['VAT collected on sales', R.vat.collected]), row(['VAT returned on refunds', -R.vat.refunded]), row(['Net VAT for the period', R.vat.net_due], { b: 1 }), row(['VAT payable balance (all time)', R.vat.balance], { b: 1 })] });
  T.push({ key: 'ratios', title: 'Key numbers', sub: per, cols: ['Measure', 'Value'], rows: [
    row(['Paid orders', R.kpis.orders]), row(['Average order value ₦', R.kpis.avg_order]), row(['Gross margin', pct(R.kpis.gross_margin)]), row(['Net margin', pct(R.kpis.net_margin)]), row(['Expenses as % of revenue', pct(R.kpis.expense_ratio)]),
    row(['Contribution margin (after cost of goods and payment fees)', pct(R.kpis.contribution_margin)]), row(['Fixed costs per month ₦', R.kpis.fixed_costs_monthly]), row(['Break-even sales per month ₦', R.kpis.break_even_monthly]),
    row(['Stock turnover (times, this period)', R.kpis.inventory_turnover]), row(['Days of stock held', R.kpis.days_in_stock]), row(['Liquidity ratio (cash + stock ÷ debts)', R.kpis.liquidity_ratio])] });
  const jr = []; for (const e of R.journal) e.lines.forEach((l, i) => jr.push(row([i ? '' : e.date, i ? '' : e.ref, `${l.a} ${ACCT[l.a] ? ACCT[l.a][0] : ''}`, i ? '' : e.memo, l.dr || null, l.cr || null])));
  T.push({ key: 'journal', title: 'Journal (every transaction)', sub: per, cols: ['Date', 'Ref', 'Account', 'Description', 'Debit ₦', 'Credit ₦'], rows: jr });
  return T;
}

module.exports = { compute, tables, settings, saveSettings, resolvePeriod, DEFAULTS, EXP_CATS, MONEY_KINDS, ACCT, today, r2 };
