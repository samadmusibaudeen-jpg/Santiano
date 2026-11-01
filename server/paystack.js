// Paystack REST helper (one Paystack account for the whole shop, key from PAYSTACK_SECRET_KEY).
const cfg = require('./config');
const ps = (path, opt = {}) => fetch('https://api.paystack.co' + path, { ...opt, headers: { Authorization: 'Bearer ' + cfg.paystackKey, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
module.exports = { ps };
