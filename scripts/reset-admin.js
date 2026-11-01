// Create or reset the admin login without losing any data.
// Usage: npm run reset-admin -- you@example.com 'a-long-password'
'use strict';
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) { console.error("Usage: npm run reset-admin -- you@example.com 'password-of-8+-characters'"); process.exit(1); }
const { q } = require('../server/db');
const { hashPassword } = require('../server/auth');
const e = email.toLowerCase(), hash = hashPassword(password), admin = q.get("SELECT id FROM users WHERE role='admin'");
if (admin) { q.run('UPDATE users SET email=?, password_hash=?, suspended=0 WHERE id=?', e, hash, admin.id); console.log('Admin updated: ' + e); }
else { q.run("INSERT INTO users(role,name,email,password_hash) VALUES('admin','Admin',?,?)", e, hash); console.log('Admin created: ' + e); }
