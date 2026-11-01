// Database for customers, orders, reviews, discount codes, settings and accounting.
// DATABASE_URL set  -> Supabase Postgres (permanent; survives redeploys).
// DATABASE_URL empty -> local SQLite file (handy for development and tests).
// Both expose the same async API: q.get / q.all / q.run / q.tx. The product catalogue itself is in Supabase (see supa.js).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const cfg = require('./config');

const usePg = !!cfg.databaseUrl;
let driver;

if (!usePg) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('customer','admin')),
    name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT,
    password_hash TEXT NOT NULL,
    address TEXT,
    suspended INTEGER NOT NULL DEFAULT 0,
    reset_token TEXT, reset_expires TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- product_id is the Supabase product id (no foreign key: products live in another database)
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5), title TEXT, body TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (product_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_email TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'delivery', address TEXT,
    subtotal REAL NOT NULL, delivery_fee REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, discount_code TEXT, total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_payment', note TEXT, refund_ref TEXT, paid_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER, name TEXT NOT NULL, variant TEXT, image TEXT, qty INTEGER NOT NULL, unit_price REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('percent','fixed')), value REAL NOT NULL, min_order REAL NOT NULL DEFAULT 0,
    max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0, expires_on TEXT, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, body TEXT, link TEXT, is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS support_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, subject TEXT NOT NULL, message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', admin_reply TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- Accounting (admin only). Cost price per product lives here because the Supabase products table has no cost column.
  CREATE TABLE IF NOT EXISTS product_costs (product_id INTEGER PRIMARY KEY, cost REAL NOT NULL CHECK (cost >= 0), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, category TEXT NOT NULL, description TEXT, vendor TEXT,
    amount REAL NOT NULL CHECK (amount > 0), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
  -- capital, drawing, loan_in, loan_repay, stock_purchase, opening_stock
  CREATE TABLE IF NOT EXISTS money_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, kind TEXT NOT NULL, description TEXT,
    amount REAL NOT NULL CHECK (amount > 0), created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS fixed_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, cost REAL NOT NULL CHECK (cost > 0), purchase_date TEXT NOT NULL,
    life_years REAL NOT NULL DEFAULT 5, salvage REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL, detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
  
  // cost of each item at the moment it was sold (so later cost changes do not rewrite old profit)
  if (!db.prepare('PRAGMA table_info(order_items)').all().some(c => c.name === 'unit_cost')) db.exec('ALTER TABLE order_items ADD COLUMN unit_cost REAL');
  let chain = Promise.resolve(); // one transaction at a time
  driver = {
    kind: 'sqlite',
    init: async () => {},
    get: async (sql, p) => db.prepare(sql).get(...p),
    all: async (sql, p) => db.prepare(sql).all(...p),
    run: async (sql, p) => db.prepare(sql).run(...p),
    async tx(fn) {
      const prev = chain; let release; chain = new Promise(r => { release = r; }); await prev;
      db.exec('BEGIN');
      try { const r = await fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { release(); }
    },
  };
} else {
  const { Pool, types } = require('pg');
  types.setTypeParser(20, v => parseInt(v, 10));   // bigint (COUNT, SUM of integers) -> number
  types.setTypeParser(1700, v => parseFloat(v));   // numeric -> number
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(cfg.databaseUrl);
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 5, idleTimeoutMillis: 30000, ssl: local ? false : { rejectUnauthorized: false } });
  pool.on('error', e => console.error('[db] idle client error', e.message));
  const als = new AsyncLocalStorage();
  const NOW = "to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')";
  const NO_ID = new Set(['settings', 'product_costs']);
  const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i))
    .replace(/datetime\('now','(-?\d+) days'\)/g, (m, n) => `to_char((now() at time zone 'utc') + interval '${+n} days','YYYY-MM-DD HH24:MI:SS')`)
    .replace(/datetime\('now'\)/g, NOW); };
  const exec = (sql, p) => (als.getStore() || pool).query(conv(sql), p);
  driver = {
    kind: 'postgres',
    init: async () => { await pool.query(fs.readFileSync(path.join(cfg.root, 'sql', 'shop-tables.sql'), 'utf8')); },
    get: async (sql, p) => (await exec(sql, p)).rows[0],
    all: async (sql, p) => (await exec(sql, p)).rows,
    async run(sql, p) {
      const m = /^\s*insert\s+into\s+(\w+)/i.exec(sql);
      if (m && !/\breturning\b/i.test(sql) && !NO_ID.has(m[1].toLowerCase())) sql += ' RETURNING id';
      const r = await exec(sql, p);
      return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? r.rows[0].id : undefined };
    },
    async tx(fn) {
      if (als.getStore()) return fn(); // already inside a transaction
      const client = await pool.connect();
      try { await client.query('BEGIN'); const r = await als.run(client, fn); await client.query('COMMIT'); return r; }
      catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
      finally { client.release(); }
    },
  };
}

const q = {
  get: (sql, ...p) => driver.get(sql, p),
  all: (sql, ...p) => driver.all(sql, p),
  run: (sql, ...p) => driver.run(sql, p),
  tx: fn => driver.tx(fn),
};
const json = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };

// Settings are tiny and read on almost every request, so they are cached in memory (this server is the only writer).
const settingsCache = new Map();
const getSetting = (k, d = null) => settingsCache.has(k) ? json(settingsCache.get(k), settingsCache.get(k)) : d;
const setSetting = async (k, v) => { const val = JSON.stringify(v); await q.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, val); settingsCache.set(k, val); };
const audit = (actor, action, detail) => q.run('INSERT INTO audit_log(actor_id,action,detail) VALUES(?,?,?)', actor || null, action, detail ? String(detail).slice(0, 500) : null);
const notify = (userId, title, body, link) => q.run('INSERT INTO notifications(user_id,title,body,link) VALUES(?,?,?,?)', userId, title, body || null, link || null);

// Shop-wide settings, editable by the admin. Defaults are used until something is saved.
const SHOP_DEFAULTS = { shop_name: cfg.shopName, delivery_fee: 2000, free_delivery_over: null, offers_pickup: false, pickup_info: '', phone: '', whatsapp: '', returns_policy: 'Contact us within 7 days of delivery if something is wrong.' };
const shopSettings = () => ({ ...SHOP_DEFAULTS, ...(getSetting('shop', {}) || {}) });

// Resolves when the tables exist and settings are loaded. The server waits for it before answering requests.
const ready = (async () => { await driver.init(); for (const r of await q.all('SELECT key, value FROM settings')) settingsCache.set(r.key, r.value); })();
ready.catch(() => {}); // the real error is reported by whoever awaits it

module.exports = { q, json, getSetting, setSetting, audit, notify, shopSettings, SHOP_DEFAULTS, ready, kind: driver.kind };
