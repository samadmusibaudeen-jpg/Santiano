const { HttpError } = require('./http');
const str = (v, max = 500, { required = false, name = 'field' } = {}) => {
  const s = v == null ? '' : String(v).trim().slice(0, max);
  if (required && !s) throw new HttpError(400, `${name} is required`);
  return s;
};
const num = (v, { min = -Infinity, max = Infinity, name = 'value', required = false } = {}) => {
  if (v === '' || v == null) { if (required) throw new HttpError(400, `${name} is required`); return null; }
  const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} is invalid`);
  return n;
};
const bool = v => (v === true || v === 1 || v === '1' || v === 'true') ? 1 : 0;
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const list = (v, maxItems = 30, maxLen = 40) => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems);
module.exports = { str, num, bool, isEmail, list };
