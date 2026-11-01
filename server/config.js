const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
// minimal .env loader
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}
const env = process.env;
module.exports = {
  root,
  port: +env.PORT || 3000,
  secret: env.APP_SECRET || 'dev-secret-change-me',
  dbPath: path.resolve(root, env.DB_PATH || './data/shop.db'),
  publicDir: path.join(root, 'public'),
  shopName: env.SHOP_NAME || 'Santiano',
  // Supabase: products and product photos live here. The service-role key stays on the server only.
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/+$/, ''),
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseBucket: env.SUPABASE_BUCKET || 'product-images',
  paystackKey: env.PAYSTACK_SECRET_KEY || '',
  // Demo payments mark orders paid without charging anyone. On by default only while there is no Paystack key.
  demoPayments: env.DEMO_PAYMENTS ? env.DEMO_PAYMENTS === 'true' : !env.PAYSTACK_SECRET_KEY,
  publicUrl: env.PUBLIC_URL || `http://localhost:${+env.PORT || 3000}`,
  adminEmail: (env.ADMIN_EMAIL || 'admin@santiano.local').toLowerCase(),
  adminPassword: env.ADMIN_PASSWORD || 'admin12345',
};
