// Supabase client (no packages): PostgREST for the products table, Storage for product photos.
// Uses the service-role key, which must only ever live in server environment variables.
const cfg = require('./config');
const { HttpError } = require('./http');

const configured = () => !!(cfg.supabaseUrl && cfg.supabaseKey);
const headers = (extra = {}) => ({ apikey: cfg.supabaseKey, Authorization: 'Bearer ' + cfg.supabaseKey, ...extra });

async function call(method, url, { body, json = true, extra = {}, raw = false } = {}) {
  if (!configured()) throw new HttpError(503, 'Supabase is not connected yet. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see the README).');
  let res;
  try {
    res = await fetch(url, { method, headers: headers(json && body !== undefined ? { 'Content-Type': 'application/json', ...extra } : extra), body: body === undefined ? undefined : (json ? JSON.stringify(body) : body), signal: AbortSignal.timeout(20000) });
  } catch (e) { throw new HttpError(502, 'Could not reach Supabase: ' + (e.cause?.code || e.message)); }
  if (!res.ok) {
    let msg = ''; try { const j = await res.json(); msg = j.message || j.error || j.hint || ''; } catch {}
    const hint = res.status === 401 || res.status === 403 ? ' Check SUPABASE_SERVICE_ROLE_KEY (use the service_role key, not the anon key).' : res.status === 404 ? ' Did you run sql/supabase.sql in the SQL editor?' : '';
    throw new HttpError(502, `Supabase error ${res.status}: ${String(msg).slice(0, 160)}.${hint}`.replace('..', '.'));
  }
  if (raw) return res;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const rest = (method, pathAndQuery, body, prefer) => call(method, `${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, { body, extra: prefer ? { Prefer: prefer } : {} });

const publicUrl = name => `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.supabaseBucket}/${name}`;
async function uploadObject(name, buffer, contentType) {
  await call('POST', `${cfg.supabaseUrl}/storage/v1/object/${cfg.supabaseBucket}/${name}`, { body: buffer, json: false, extra: { 'Content-Type': contentType, 'Cache-Control': 'max-age=31536000', 'x-upsert': 'false' } });
  return publicUrl(name);
}
async function deleteObject(name) { await call('DELETE', `${cfg.supabaseUrl}/storage/v1/object/${cfg.supabaseBucket}/${name}`, { raw: true }).catch(() => {}); }
// Only objects in our own bucket are ours to delete.
const objectNameFromUrl = url => { const p = `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.supabaseBucket}/`; return url && cfg.supabaseUrl && String(url).startsWith(p) ? String(url).slice(p.length) : null; };

module.exports = { configured, rest, uploadObject, deleteObject, objectNameFromUrl, publicUrl };
