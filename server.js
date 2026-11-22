import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = process.cwd();
const dataDir = resolve(process.env.DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'zahid.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'pending',
    credits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS credit_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
    credits INTEGER NOT NULL, paid_amount REAL NOT NULL, currency TEXT NOT NULL,
    payment_method TEXT NOT NULL, transaction_ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
    reviewed_at TEXT, reviewed_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
    amount INTEGER NOT NULL, kind TEXT NOT NULL, note TEXT NOT NULL,
    ref TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    request_json TEXT NOT NULL, response_json TEXT NOT NULL,
    credits_required INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
    api_job_id TEXT NOT NULL UNIQUE, batch_id TEXT, status TEXT NOT NULL,
    model TEXT NOT NULL, duration_seconds INTEGER NOT NULL, aspect_ratio TEXT NOT NULL DEFAULT '9:16',
    resolution TEXT NOT NULL DEFAULT '720p', prompt TEXT NOT NULL,
    credits_charged INTEGER NOT NULL, error_code TEXT, video_url TEXT,
    refunded INTEGER NOT NULL DEFAULT 0, refund_processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS create_keys (
    user_id INTEGER NOT NULL REFERENCES users(id), idem_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT,
    quote_id TEXT NOT NULL, credits_required INTEGER NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(user_id, idem_key)
  );
  CREATE INDEX IF NOT EXISTS jobs_user_updated ON jobs(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS credit_requests_status ON credit_requests(status, created_at);
`);
try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN city TEXT NOT NULL DEFAULT ''"); } catch { /* column already exists */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN refund_processed INTEGER NOT NULL DEFAULT 0'); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '9:16'"); } catch { /* column already exists */ }
try { db.exec("ALTER TABLE jobs ADD COLUMN resolution TEXT NOT NULL DEFAULT '720p'"); } catch { /* column already exists */ }

const nowIso = () => new Date().toISOString();
const apiKey = process.env.KLING_API_KEY;
const baseUrl = 'https://klinggiare.com';
const sessionDays = 14;
const sessionCookie = 'zahid_session';
const rateLimits = new Map();

function setting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
function saveSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}
const socialKeys = ['tiktok', 'youtube', 'facebook', 'instagram'];
function publicSocialLinks() {
  try { return Object.fromEntries(socialKeys.map(key => [key, JSON.parse(setting(`social_${key}`, '""'))])); }
  catch { return Object.fromEntries(socialKeys.map(key => [key, ''])); }
}
saveSetting('creditsPerVnd', setting('creditsPerVnd', '1'));
saveSetting('currency', setting('currency', 'PKR'));
saveSetting('paymentInstructions', setting('paymentInstructions', ''));
saveSetting('paymentMethods', setting('paymentMethods', 'JazzCash,EasyPaisa,Bank transfer'));
if (setting('paymentSetupVersion') !== '3') {
  saveSetting('paymentMethods', 'JazzCash,EasyPaisa,Bank transfer');
  saveSetting('paymentInstructions', 'EasyPaisa — 03277184049\nAccount name: Muhammad Mursaleen\n\nJazzCash — 03097291283\nAccount name: Ghulam Sakeena\n\nBank transfer — United Bank Limited (UBL)\nAccount name: Muhammad Zahid Kareem\nIBAN: PK47UNIL0109000289796852\n\nAfter payment, submit your transaction reference in Zahid AI and send your payment screenshot to WhatsApp 03079709624. Credits are added after admin approval.');
  saveSetting('paymentSetupVersion', '3');
}

function makePassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function passwordMatches(password, salt, expected) {
  const actual = scryptSync(password, salt, 64);
  const hash = Buffer.from(expected, 'hex');
  return actual.length === hash.length && timingSafeEqual(actual, hash);
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function json(res, status, value, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(value));
}
function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
async function readJson(req, maxBytes = 4 * 1024 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw fail(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw fail(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
  }));
}
function cookieHeader(token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${sessionCookie}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}
function getSession(req) {
  const token = cookies(req)[sessionCookie];
  if (!token) return null;
  const row = db.prepare(`SELECT s.csrf,s.expires_at,u.id,u.email,u.role,u.status,u.credits,u.created_at
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(sha(token));
  if (!row || row.expires_at < Date.now()) return null;
  return { ...row, tokenHash: sha(token) };
}
function requireAuth(req, { admin = false, approved = false, csrf = false } = {}) {
  const user = getSession(req);
  if (!user) throw fail(401, 'UNAUTHENTICATED', 'Please sign in again.');
  if (admin && user.role !== 'admin') throw fail(403, 'ADMIN_REQUIRED', 'Administrator access is required.');
  if (approved && user.status !== 'active') throw fail(403, 'ACCOUNT_PENDING', user.status === 'suspended' ? 'This account is suspended.' : 'Your account is waiting for admin approval.');
  if (csrf) {
    const origin = req.headers.origin;
    const host = req.headers.host;
    if (origin && new URL(origin).host !== host) throw fail(403, 'BAD_ORIGIN', 'This request origin is not allowed.');
    if (req.headers['x-csrf-token'] !== user.csrf) throw fail(403, 'CSRF', 'Refresh the page and try again.');
  }
  return user;
}
function rateLimit(req, key, limit, periodMs) {
  const ip = req.socket.remoteAddress || 'unknown';
  const id = `${ip}:${key}`;
  const now = Date.now();
  const entry = rateLimits.get(id) || { start: now, count: 0 };
  if (now - entry.start > periodMs) { entry.start = now; entry.count = 0; }
  entry.count++;
  rateLimits.set(id, entry);
  if (entry.count > limit) throw fail(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.');
}
async function upstream(path, options = {}) {
  if (!apiKey) throw fail(503, 'API_KEY_MISSING', 'The server needs KLING_API_KEY configured.');
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
    });
  } catch { throw fail(502, 'UPSTREAM_NETWORK', 'Could not connect to the video generation service. Try again shortly.'); }
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.message || `The video service returned ${response.status}.`), { status: response.status, code: data?.error?.code || 'UPSTREAM_ERROR', retryAfter: response.headers.get('Retry-After') });
  return data;
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function publicUser(user) {
  return { id: user.id, email: user.email, phone: user.phone || '', city: user.city || '', role: user.role, status: user.status, credits: user.credits, createdAt: user.created_at };
}
function userById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id); }
function ledger(userId, amount, kind, note, ref = null) {
  db.prepare('INSERT INTO ledger(user_id,amount,kind,note,ref,created_at) VALUES(?,?,?,?,?,?)').run(userId, amount, kind, note, ref, nowIso());
}
function updateJobFromApi(userId, apiJob) {
  const row = db.prepare('SELECT * FROM jobs WHERE user_id=? AND api_job_id=?').get(userId, String(apiJob.id));
  if (!row) throw fail(404, 'JOB_NOT_FOUND', 'Job not found.');
  const status = String(apiJob.status || row.status);
  transaction(() => {
    db.prepare('UPDATE jobs SET status=?,model=?,error_code=?,updated_at=? WHERE id=?')
      .run(status, apiJob.model || row.model, apiJob.errorCode || null, nowIso(), row.id);
    if (['failed', 'canceled'].includes(status) && !row.refund_processed) {
      const keepCharge = apiJob.errorCode === 'POLICY_VIOLATION_NO_REFUND';
      db.prepare('UPDATE jobs SET refunded=?,refund_processed=1 WHERE id=?').run(keepCharge ? 0 : 1, row.id);
      if (!keepCharge && row.credits_charged > 0) {
        db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(row.credits_charged, userId);
        ledger(userId, row.credits_charged, 'refund', `Refund for video job ${row.api_job_id}`, String(row.api_job_id));
      }
    }
  });
  return db.prepare('SELECT * FROM jobs WHERE id=?').get(row.id);
}
function jobView(row) {
  return { id: row.id, jobId: row.api_job_id, batchId: row.batch_id, status: row.status, model: row.model,
    durationSeconds: row.duration_seconds, aspectRatio: row.aspect_ratio, resolution: row.resolution, prompt: row.prompt, creditsCharged: row.credits_charged,
    errorCode: row.error_code, videoUrl: row.video_url, refunded: Boolean(row.refunded), createdAt: row.created_at, updatedAt: row.updated_at };
}

// Seed the first administrator only on an empty database. No demo accounts are created.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || email.includes('example.com') || !password || password.length < 12 || /replace_|your-admin|placeholder/i.test(password)) {
    console.error('First run setup required: set ADMIN_EMAIL and a 12+ character ADMIN_PASSWORD in .env, then restart.');
    process.exit(1);
  }
  const pwd = makePassword(password);
  db.prepare(`INSERT INTO users(email,password_salt,password_hash,role,status,credits,created_at) VALUES(?,?,?,'admin','active',0,?)`)
    .run(email, pwd.salt, pwd.hash, nowIso());
  console.log(`Created first admin account for ${email}.`);
}

// Existing accounts that were waiting for manual approval are activated once;
// new registrations are active immediately as well.
if (setting('signupApprovalVersion') !== '1') {
  db.prepare("UPDATE users SET status='active' WHERE role='user' AND status='pending'").run();
  saveSetting('signupApprovalVersion', '1');
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw fail(403, 'BAD_ORIGIN', 'This request origin is not allowed.');
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, database: true, klingConfigured: Boolean(apiKey) });
    if (req.method === 'GET' && url.pathname === '/api/prices') {
      const response = await fetch(`${baseUrl}/api/v1/prices`);
      return json(res, response.status, await response.json());
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const response = await fetch(`${baseUrl}/api/v1/system/status`);
      return json(res, response.status, await response.json());
    }
    if (req.method === 'GET' && url.pathname === '/api/public-settings') {
      return json(res, 200, { socialLinks: publicSocialLinks() });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      rateLimit(req, 'register', 6, 60 * 60_000);
      const body = await readJson(req, 16_000);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const confirmPassword = String(body.confirmPassword || '');
      const phoneInput = String(body.phone || '').trim();
      const city = String(body.city || '').trim();
      const phone = phoneInput.replace(/[\s().-]/g, '');
      if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw fail(422, 'INVALID_EMAIL', 'Enter a valid email address.');
      if (!/^\+?\d{8,15}$/.test(phone)) throw fail(422, 'INVALID_PHONE', 'Enter a valid WhatsApp number with country code (8–15 digits).');
      if (city.length < 2 || city.length > 100) throw fail(422, 'INVALID_CITY', 'Enter your city (2–100 characters).');
      if (password.length < 12 || password.length > 200) throw fail(422, 'WEAK_PASSWORD', 'Use a password with at least 12 characters.');
      if (password !== confirmPassword) throw fail(422, 'PASSWORD_MISMATCH', 'The passwords do not match.');
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw fail(409, 'EMAIL_EXISTS', 'An account with this email already exists.');
      const pwd = makePassword(password);
      const created = nowIso();
      const result = db.prepare(`INSERT INTO users(email,password_salt,password_hash,phone,city,role,status,credits,created_at) VALUES(?,?,?,?,?,'user','active',0,?)`).run(email, pwd.salt, pwd.hash, phone, city, created);
      const user = userById(result.lastInsertRowid);
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      const expires = Date.now() + sessionDays * 86400_000;
      db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(sha(token), user.id, csrf, expires);
      return json(res, 201, { registered: true, status: 'active', user: publicUser(user), csrf, message: 'Your account is ready. Add credits to start generating videos.' }, { 'Set-Cookie': cookieHeader(token, sessionDays * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      rateLimit(req, 'login', 12, 15 * 60_000);
      const body = await readJson(req, 16_000);
      const email = String(body.email || '').trim().toLowerCase();
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const dummy = '0'.repeat(128);
      if (!user || !passwordMatches(String(body.password || ''), user.password_salt || '00000000000000000000000000000000', user.password_hash || dummy)) throw fail(401, 'LOGIN_FAILED', 'Email or password is incorrect.');
      if (user.status === 'suspended') throw fail(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      const token = randomBytes(32).toString('base64url');
      const csrf = randomBytes(24).toString('base64url');
      const expires = Date.now() + sessionDays * 86400_000;
      db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)').run(sha(token), user.id, csrf, expires);
      return json(res, 200, { user: publicUser(user), csrf }, { 'Set-Cookie': cookieHeader(token, sessionDays * 86400) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const user = requireAuth(req, { csrf: true });
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(user.tokenHash);
      return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = getSession(req);
      if (!user) return json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'Please sign in.' } });
      const recent = db.prepare('SELECT id,credits,paid_amount,currency,payment_method,transaction_ref,status,created_at,reviewed_at FROM credit_requests WHERE user_id=? ORDER BY id DESC LIMIT 20').all(user.id);
      return json(res, 200, { user: publicUser(user), csrf: user.csrf,
        billing: { currency: setting('currency', 'PKR'), creditsPerVnd: Number(setting('creditsPerVnd', '1')), paymentInstructions: setting('paymentInstructions'), paymentMethods: setting('paymentMethods').split(',').map(x => x.trim()).filter(Boolean) },
        creditRequests: recent });
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const user = requireAuth(req);
      const rows = db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 100').all(user.id);
      return json(res, 200, { jobs: rows.map(jobView) });
    }
    if (req.method === 'POST' && url.pathname === '/api/uploads/init') {
      const user = requireAuth(req, { approved: true, csrf: true });
      rateLimit(req, `upload:${user.id}`, 20, 60_000);
      const body = await readJson(req, 1024 * 1024);
      return json(res, 200, await upstream('/api/v1/ext/batches/uploads/init', { method: 'POST', body: JSON.stringify(body) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/uploads/complete') {
      requireAuth(req, { approved: true, csrf: true });
      const body = await readJson(req, 1024 * 1024);
      return json(res, 200, await upstream('/api/v1/ext/batches/uploads/complete', { method: 'POST', body: JSON.stringify(body) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/quote') {
      const user = requireAuth(req, { approved: true, csrf: true });
      rateLimit(req, `quote:${user.id}`, 30, 60_000);
      const request = await readJson(req);
      const quote = await upstream('/api/v1/ext/batches/quote', { method: 'POST', body: JSON.stringify(request) });
      const creditsRequired = Math.ceil(Number(quote.totalAmount || 0) * Number(setting('creditsPerVnd', '1')));
      const id = randomUUID();
      const expiresAt = Date.now() + 10 * 60_000;
      db.prepare('INSERT INTO quotes(id,user_id,request_json,response_json,credits_required,expires_at) VALUES(?,?,?,?,?,?)')
        .run(id, user.id, JSON.stringify(request), JSON.stringify(quote), creditsRequired, expiresAt);
      return json(res, 200, { ...quote, quoteId: id, creditsRequired, creditsAvailable: user.credits, expiresAt });
    }
    if (req.method === 'POST' && url.pathname === '/api/batches') {
      const user = requireAuth(req, { approved: true, csrf: true });
      rateLimit(req, `generate:${user.id}`, 10, 60_000);
      const body = await readJson(req);
      const quoteId = String(body.quoteId || '');
      const idemKey = String(req.headers['idempotency-key'] || randomUUID());
      const quoteRow = db.prepare('SELECT * FROM quotes WHERE id=? AND user_id=?').get(quoteId, user.id);
      if (!quoteRow || quoteRow.expires_at < Date.now()) throw fail(409, 'QUOTE_EXPIRED', 'Get a new price quote before creating the video.');
      const prior = db.prepare('SELECT * FROM create_keys WHERE user_id=? AND idem_key=?').get(user.id, idemKey);
      const bodyForHash = { ...body }; delete bodyForHash.quoteId;
      const payloadHash = sha(JSON.stringify(bodyForHash));
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw fail(409, 'IDEMPOTENCY_CONFLICT', 'This request key was used for different video settings.');
        if (prior.state === 'complete') return json(res, 200, JSON.parse(prior.response_json));
        if (prior.state === 'creating') throw fail(409, 'IDEMPOTENCY_IN_PROGRESS', 'This video request is still being processed.');
      }
      const quoteReq = JSON.parse(quoteRow.request_json);
      const quote = JSON.parse(quoteRow.response_json);
      const quotedMotion = quoteReq.motionControl === true;
      const createdMotion = body.jobType === 'motion_control' || Boolean(body.motionVideoObjectKey || body.motionVideoObjectKeys);
      const quotedOmni = quoteReq.omniReference === true || quoteReq.jobType === 'omni_reference' || quoteReq.settings?.jobType === 'omni_reference';
      const createdOmni = body.omniReference === true || body.jobType === 'omni_reference';
      const quotedTail = quoteReq.tailImage === true;
      const createdTail = Boolean(body.endFrameKey || (Array.isArray(body.jobs) && body.jobs.some(job => job.tailObjectKey)));
      const quotedText = quoteReq.textToVideo === true || quoteReq.jobType === 'text_to_video';
      const hasCreateImages = (Array.isArray(body.imageKeys) && body.imageKeys.length > 0) || (Array.isArray(body.jobs) && body.jobs.some(job => job.inputObjectKey));
      const createdText = body.jobType === 'text_to_video' || (!hasCreateImages && !createdMotion && !createdOmni);
      if (quotedMotion !== createdMotion || quotedOmni !== createdOmni || quotedTail !== createdTail || quotedText !== createdText) throw fail(409, 'QUOTE_MODE_MISMATCH', 'The selected generation mode changed. Request a new quote.');
      if (quoteReq.jobType === 'image_to_video' && body.jobType !== 'image_to_video') throw fail(409, 'QUOTE_MODE_MISMATCH', 'The selected image-to-video mode changed. Request a new quote.');
      const prompts = Array.isArray(body.prompts) ? body.prompts : [body.prompt].filter(Boolean);
      const quotePromptCount = Number(quoteReq.promptCount || quoteReq.prompts?.length || 1);
      const settings = body.settings || {};
      const priceFields = ['model', 'durationSeconds', 'aspectRatio', 'resolution', 'audio'];
      if (priceFields.some(k => String(settings[k] ?? '') !== String(quoteReq.settings?.[k] ?? ''))) throw fail(409, 'QUOTE_MISMATCH', 'Video settings changed. Get a fresh quote.');
      if (!prompts.length || prompts.length !== quotePromptCount || prompts.some(p => !String(p).trim())) throw fail(422, 'PROMPT_COUNT_MISMATCH', 'Prompt count does not match the quote.');
      const imageKeys = Array.isArray(body.imageKeys) ? body.imageKeys : [];
      if (imageKeys.length !== Number(quoteReq.imageCount || 1) && !(quoteReq.textToVideo && !imageKeys.length)) throw fail(422, 'IMAGE_COUNT_MISMATCH', 'Image count does not match the quote.');
      if (quoteRow.consumed && !prior) throw fail(409, 'QUOTE_USED', 'This quote was already used. Request a new quote.');
      const charge = quoteRow.credits_required;
      if (user.credits < charge) throw fail(422, 'INSUFFICIENT_APP_CREDITS', `This batch needs ${charge} credits; your balance is ${user.credits}.`);
      const upstreamBody = { ...body, expectedTotal: Number(quote.totalAmount) };
      delete upstreamBody.quoteId;
      const idempotency = idemKey;
      if (!prior) {
        transaction(() => {
          const latest = userById(user.id);
          if (latest.credits < charge) throw fail(422, 'INSUFFICIENT_APP_CREDITS', `This batch needs ${charge} credits; your balance is ${latest.credits}.`);
          if (charge > 0) { db.prepare('UPDATE users SET credits=credits-? WHERE id=?').run(charge, user.id); ledger(user.id, -charge, 'generation', `Reserved credits for ${prompts.length} video(s)`, quoteId); }
          db.prepare('UPDATE quotes SET consumed=1 WHERE id=?').run(quoteId);
          db.prepare(`INSERT INTO create_keys(user_id,idem_key,payload_hash,state,quote_id,credits_required,created_at) VALUES(?,?,?,'creating',?,?,?)`)
            .run(user.id, idempotency, payloadHash, quoteId, charge, nowIso());
        });
      } else {
        db.prepare("UPDATE create_keys SET state='creating' WHERE user_id=? AND idem_key=?").run(user.id, idemKey);
      }
      let created;
      try {
        created = await upstream('/api/v1/ext/batches', { method: 'POST', headers: { 'Idempotency-Key': idempotency }, body: JSON.stringify(upstreamBody) });
      } catch (error) {
        const definitelyRejected = error.status >= 400 && error.status < 500 && !(error.status === 409 && error.code === 'IDEMPOTENCY_IN_PROGRESS');
        if (definitelyRejected) transaction(() => {
          if (charge > 0) { db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(charge, user.id); ledger(user.id, charge, 'refund', `Create failed: ${error.code || 'API error'}`, quoteId); }
          db.prepare('UPDATE quotes SET consumed=0 WHERE id=?').run(quoteId);
          db.prepare("UPDATE create_keys SET state='failed' WHERE user_id=? AND idem_key=?").run(user.id, idemKey);
        });
        else db.prepare("UPDATE create_keys SET state='unknown' WHERE user_id=? AND idem_key=?").run(user.id, idemKey);
        throw error;
      }
      const jobs = Array.isArray(created?.jobs) ? created.jobs : [];
      if (!jobs.length) {
        db.prepare("UPDATE create_keys SET state='unknown' WHERE user_id=? AND idem_key=?").run(user.id, idemKey);
        throw fail(502, 'UNKNOWN_CREATE_RESULT', 'The video service accepted the request but did not return job IDs. Keep this page and contact support before retrying.');
      }
      const each = Math.floor(charge / jobs.length);
      const extra = charge - each * jobs.length;
      const stamp = nowIso();
      const stored = jobs.map((job, i) => {
        const prompt = prompts[i] || prompts[0];
        const jobCharge = each + (i === jobs.length - 1 ? extra : 0);
        db.prepare(`INSERT INTO jobs(user_id,api_job_id,batch_id,status,model,duration_seconds,aspect_ratio,resolution,prompt,credits_charged,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id, String(job.id), String(created.id || created.batchId || ''), job.status || 'queued', settings.model, Number(settings.durationSeconds), settings.aspectRatio || '9:16', settings.resolution || '720p', prompt, jobCharge, stamp, stamp);
        return { jobId: String(job.id), status: job.status || 'queued' };
      });
      const response = { batchId: String(created.id || created.batchId || ''), jobs: stored, creditsCharged: charge, creditsRemaining: user.credits - charge };
      db.prepare("UPDATE create_keys SET state='complete',response_json=? WHERE user_id=? AND idem_key=?").run(JSON.stringify(response), user.id, idemKey);
      return json(res, 201, response);
    }
    const userJob = url.pathname.match(/^\/api\/jobs\/(\d+)(\/video-url)?$/);
    if (req.method === 'GET' && userJob) {
      const user = requireAuth(req);
      const job = db.prepare('SELECT * FROM jobs WHERE user_id=? AND api_job_id=?').get(user.id, userJob[1]);
      if (!job) throw fail(404, 'JOB_NOT_FOUND', 'Job not found.');
      if (userJob[2]) {
        const video = await upstream(`/api/v1/ext/jobs/${userJob[1]}/video-url`);
        db.prepare('UPDATE jobs SET video_url=?,updated_at=? WHERE id=?').run(video.url || null, nowIso(), job.id);
        return json(res, 200, video);
      }
      const upstreamJob = await upstream(`/api/v1/ext/jobs/${userJob[1]}`);
      const updated = updateJobFromApi(user.id, upstreamJob);
      return json(res, 200, { ...upstreamJob, refunded: Boolean(updated.refunded) });
    }
    if (req.method === 'POST' && url.pathname === '/api/credit-requests') {
      const user = requireAuth(req, { csrf: true });
      const body = await readJson(req, 16_000);
      const credits = Number(body.credits);
      const amount = Number(body.paidAmount);
      const method = String(body.paymentMethod || '').trim();
      const ref = String(body.transactionRef || '').trim();
      const methods = setting('paymentMethods').split(',').map(x => x.trim()).filter(Boolean);
      if (!setting('paymentInstructions').trim()) throw fail(409, 'PAYMENTS_NOT_CONFIGURED', 'The administrator has not set payment instructions yet.');
      if (!Number.isSafeInteger(credits) || credits < 1 || credits > 100_000_000) throw fail(422, 'INVALID_CREDITS', 'Enter a valid credit amount.');
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw fail(422, 'INVALID_AMOUNT', 'Enter a valid amount paid.');
      if (!methods.includes(method) || ref.length < 3 || ref.length > 120) throw fail(422, 'INVALID_PAYMENT', 'Select a payment method and enter the transfer reference.');
      const result = db.prepare(`INSERT INTO credit_requests(user_id,credits,paid_amount,currency,payment_method,transaction_ref,status,created_at)
        VALUES(?,?,?,?,?,?,'pending',?)`).run(user.id, credits, amount, setting('currency', 'PKR'), method, ref, nowIso());
      return json(res, 201, { id: result.lastInsertRowid, status: 'pending' });
    }
    if (req.method === 'GET' && url.pathname === '/api/ledger') {
      const user = requireAuth(req);
      const rows = db.prepare('SELECT amount,kind,note,ref,created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 100').all(user.id);
      return json(res, 200, { transactions: rows });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/overview') {
      requireAuth(req, { admin: true });
      const wallet = await upstream('/api/v1/ext/wallet');
      const summary = {
        users: db.prepare("SELECT count(*) AS total FROM users WHERE role='user'").get().total,
        pendingUsers: db.prepare("SELECT count(*) count FROM users WHERE role='user' AND status='pending'").get().count,
        pendingPayments: db.prepare("SELECT count(*) count FROM credit_requests WHERE status='pending'").get().count,
        jobs: db.prepare('SELECT count(*) count FROM jobs').get().count,
        wallet: { balance: wallet.balance, heldReserve: wallet.heldReserve, currency: 'VND', updatedAt: wallet.updatedAt }
      };
      return json(res, 200, summary);
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/users') {
      requireAuth(req, { admin: true });
      const users = db.prepare('SELECT id,email,phone,city,role,status,credits,created_at FROM users ORDER BY id').all();
      return json(res, 200, { users });
    }
    if (req.method === 'PATCH' && (url.pathname.match(/^\/api\/admin\/users\/\d+$/))) {
      const admin = requireAuth(req, { admin: true, csrf: true });
      const id = Number(url.pathname.split('/').pop());
      const body = await readJson(req, 16_000);
      const target = userById(id);
      if (!target) throw fail(404, 'USER_NOT_FOUND', 'User not found.');
      if (target.role === 'admin' && id === admin.id) throw fail(409, 'SELF_CHANGE', 'You cannot suspend yourself.');
      if (body.status && !['pending', 'active', 'suspended'].includes(body.status)) throw fail(422, 'INVALID_STATUS', 'Invalid account status.');
      if (body.status) db.prepare('UPDATE users SET status=? WHERE id=?').run(body.status, id);
      return json(res, 200, { user: publicUser(userById(id)) });
    }
    if (req.method === 'POST' && (url.pathname.match(/^\/api\/admin\/users\/\d+\/promote$/))) {
      const admin = requireAuth(req, { admin: true, csrf: true });
      const id = Number(url.pathname.split('/')[4]);
      const target = userById(id);
      if (!target) throw fail(404, 'USER_NOT_FOUND', 'User not found.');
      if (id === admin.id) throw fail(409, 'SELF_CHANGE', 'You are already an administrator.');
      if (target.role === 'admin') throw fail(409, 'ALREADY_ADMIN', 'This account is already an administrator.');
      if (target.status !== 'active') throw fail(409, 'USER_NOT_ACTIVE', 'Activate this account before making it an administrator.');
      db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
      return json(res, 200, { user: publicUser(userById(id)) });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/users\/\d+\/credits$/)) {
      requireAuth(req, { admin: true, csrf: true });
      const id = Number(url.pathname.split('/')[4]);
      const body = await readJson(req, 16_000);
      const delta = Number(body.amount);
      const note = String(body.note || '').trim().slice(0, 160);
      if (!userById(id)) throw fail(404, 'USER_NOT_FOUND', 'User not found.');
      if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000_000) throw fail(422, 'INVALID_CREDITS', 'Credit adjustment must be a non-zero whole number.');
      transaction(() => {
        const current = userById(id);
        if (current.credits + delta < 0) throw fail(409, 'NEGATIVE_BALANCE', 'This would make the user balance negative.');
        db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(delta, id);
        ledger(id, delta, 'admin_adjustment', note || 'Administrator credit adjustment');
      });
      return json(res, 200, { user: publicUser(userById(id)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/credit-requests') {
      requireAuth(req, { admin: true });
      return json(res, 200, { requests: db.prepare(`SELECT r.*,u.email FROM credit_requests r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 200`).all() });
    }
    if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/credit-requests\/\d+$/)) {
      const admin = requireAuth(req, { admin: true, csrf: true });
      const id = Number(url.pathname.split('/').pop());
      const body = await readJson(req, 16_000);
      if (!['approved', 'rejected'].includes(body.decision)) throw fail(422, 'INVALID_DECISION', 'Choose approve or reject.');
      transaction(() => {
        const request = db.prepare('SELECT * FROM credit_requests WHERE id=?').get(id);
        if (!request) throw fail(404, 'REQUEST_NOT_FOUND', 'Payment request not found.');
        if (request.status !== 'pending') throw fail(409, 'ALREADY_REVIEWED', 'This payment request has already been reviewed.');
        db.prepare('UPDATE credit_requests SET status=?,reviewed_at=?,reviewed_by=? WHERE id=?').run(body.decision, nowIso(), admin.id, id);
        if (body.decision === 'approved') {
          db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(request.credits, request.user_id);
          ledger(request.user_id, request.credits, 'topup', `Approved ${request.payment_method} payment ${request.transaction_ref}`, String(id));
        }
      });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
      requireAuth(req, { admin: true });
      return json(res, 200, { currency: setting('currency', 'PKR'), creditsPerVnd: Number(setting('creditsPerVnd', '1')), paymentInstructions: setting('paymentInstructions'), paymentMethods: setting('paymentMethods'), socialLinks: publicSocialLinks() });
    }
    if (req.method === 'PUT' && url.pathname === '/api/admin/settings') {
      requireAuth(req, { admin: true, csrf: true });
      const body = await readJson(req, 32_000);
      const rate = Number(body.creditsPerVnd);
      const currency = String(body.currency || '').trim().toUpperCase();
      const instructions = String(body.paymentInstructions || '').trim().slice(0, 3000);
      const methods = String(body.paymentMethods || '').split(',').map(x => x.trim()).filter(Boolean);
      const socialLinks = body.socialLinks || {};
      const shouldUpdateSocialLinks = Object.hasOwn(body, 'socialLinks');
      if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000 || !/^[A-Z]{3,6}$/.test(currency) || !methods.length || methods.length > 8) throw fail(422, 'INVALID_SETTINGS', 'Check the credit conversion rate, currency, and payment methods.');
      if (shouldUpdateSocialLinks) {
        const normalizedSocialLinks = {};
        for (const key of socialKeys) {
          const value = String(socialLinks[key] || '').trim();
          if (!value) { normalizedSocialLinks[key] = ''; continue; }
          let parsed;
          try { parsed = new URL(value); } catch { throw fail(422, 'INVALID_SOCIAL_LINK', `Enter a valid ${key} profile URL.`); }
          const host = parsed.hostname.toLowerCase();
          if (parsed.protocol !== 'https:' || !(host === `${key}.com` || host.endsWith(`.${key}.com`) || (key === 'youtube' && (host === 'youtu.be' || host.endsWith('.youtu.be'))))) throw fail(422, 'INVALID_SOCIAL_LINK', `Use an HTTPS ${key} profile URL.`);
          normalizedSocialLinks[key] = parsed.toString();
        }
        for (const key of socialKeys) saveSetting(`social_${key}`, JSON.stringify(normalizedSocialLinks[key]));
      }
      saveSetting('creditsPerVnd', rate);
      saveSetting('currency', currency);
      saveSetting('paymentInstructions', instructions);
      saveSetting('paymentMethods', methods.join(','));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/jobs') {
      requireAuth(req, { admin: true });
      const rows = db.prepare(`SELECT j.*,u.email FROM jobs j JOIN users u ON u.id=j.user_id ORDER BY j.id DESC LIMIT 200`).all();
      return json(res, 200, { jobs: rows });
    }

    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'zahid_ai_kling_ai_video_generation_platform (2).html' : normalize(decodeURIComponent(url.pathname.slice(1)));
      if (relative !== 'zahid_ai_kling_ai_video_generation_platform (2).html') throw fail(404, 'NOT_FOUND', 'Not found.');
      const file = resolve(join(root, 'frontend', relative));
      if (!file.startsWith(`${resolve(join(root, 'frontend'))}${sep}`)) return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
      const info = await stat(file);
      if (!info.isFile()) throw fail(404, 'NOT_FOUND', 'Not found.');
      const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; media-src https:; connect-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
      return res.end(await readFile(file));
    }
    throw fail(404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    const status = Number(error.status) || 500;
    return json(res, status, { error: { code: error.code || 'SERVER_ERROR', message: status >= 500 && status === 500 ? 'Server error. Please try again.' : error.message, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) } });
  }
}

createServer((req, res) => { handle(req, res); }).listen(Number(process.env.PORT || 3000), () => console.log(`Zahid AI server listening on port ${process.env.PORT || 3000}`));
