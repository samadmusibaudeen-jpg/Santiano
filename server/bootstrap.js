// First-run setup: creates the admin account from ADMIN_EMAIL / ADMIN_PASSWORD.
const cfg = require('./config');
const { q } = require('./db');
const { hashPassword } = require('./auth');
function bootstrap() {
  if (!q.get("SELECT id FROM users WHERE role='admin'")) {
    q.run("INSERT INTO users(role,name,email,password_hash) VALUES('admin','Admin',?,?)", cfg.adminEmail, hashPassword(cfg.adminPassword));
    console.log(`[setup] Admin created: ${cfg.adminEmail}${cfg.adminPassword === 'admin12345' ? ' / admin12345  (change this: set ADMIN_PASSWORD)' : ''}`);
  }
}
module.exports = { bootstrap };
