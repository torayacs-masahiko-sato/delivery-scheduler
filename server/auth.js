/**
 * 認証まわり（ログイン・セッショントークン・多要素認証 TOTP）
 *
 * なぜ別ファイルにしたか:
 *   index.js が大きくなりすぎているため、セキュリティ関連だけをここにまとめて読みやすくした。
 *
 * 環境変数（どちらも未設定でも動くが、本番では設定を推奨）:
 *   SESSION_SECRET      … ログイン済みトークンの署名鍵（未設定時は DATABASE_URL から自動生成）
 *   MFA_ENCRYPTION_KEY  … 認証アプリ用シークレットのDB保存時暗号化キー（未設定時は SESSION_SECRET を流用）
 *
 * 外部ライブラリは QR画像生成用の `qrcode` のみ。TOTP(RFC6238)・暗号化・署名は Node 標準の crypto で実装。
 */
const crypto = require('crypto');
const QRCode = require('qrcode');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // ログインの有効時間: 12時間
const MFA_TOKEN_TTL_MS = 5 * 60 * 1000;     // パスワード通過後〜コード入力までの猶予: 5分
const SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;  // 初回設定の猶予: 15分
const MAX_FAILS = 5;                        // 連続失敗の上限
const LOCK_MS = 10 * 60 * 1000;             // 上限到達時のロック時間: 10分
const ISSUER = '納品スケジューラー';

// ── 秘密鍵まわり ──────────────────────────────────────────────
const baseSecret = process.env.SESSION_SECRET
  || (process.env.DATABASE_URL
    ? crypto.createHash('sha256').update('ds-session:' + process.env.DATABASE_URL).digest('hex')
    : crypto.randomBytes(32).toString('hex'));
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️ SESSION_SECRET が未設定です。DATABASE_URL から自動生成した鍵を使用します（本番では SESSION_SECRET の設定を推奨）');
}
const SIGN_KEY = crypto.createHash('sha256').update('sign:' + baseSecret).digest();
const ENC_KEY = crypto.createHash('sha256').update('enc:' + (process.env.MFA_ENCRYPTION_KEY || baseSecret)).digest();

const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ── トークン（payload.署名）──────────────────────────────────
function signToken(payload, ttlMs) {
  const body = b64u(JSON.stringify({ ...payload, e: Date.now() + ttlMs }));
  const sig = b64u(crypto.createHmac('sha256', SIGN_KEY).update(body).digest());
  return `${body}.${sig}`;
}
function verifyToken(token, purpose) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SIGN_KEY).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.p !== purpose || !p.e || p.e < Date.now()) return null;
    return p;
  } catch { return null; }
}

// ── シークレットの暗号化（AES-256-GCM）────────────────────────
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${b64u(iv)}:${b64u(c.getAuthTag())}:${b64u(enc)}`;
}
function decrypt(stored) {
  const [v, iv, tag, enc] = String(stored).split(':');
  if (v !== 'v1') throw new Error('unknown format');
  const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ── TOTP（RFC 6238 / 6桁 / 30秒 / SHA-1。Google Authenticator 等と互換）──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1000000).padStart(6, '0');
}
/** 一致した時間ステップ番号を返す（不一致なら null）。前後1ステップ（±30秒）の端末時刻ずれを許容 */
function totpMatch(secretBase32, code, nowMs = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const buf = base32Decode(secretBase32);
  const step = Math.floor(nowMs / 30000);
  for (const d of [0, -1, 1]) {
    const cand = hotp(buf, step + d);
    if (crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(code))) return step + d;
  }
  return null;
}

// ── バックアップコード ───────────────────────────────────────
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normBackup = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
function generateBackupCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10); // 10文字
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

function createAuth({ pool, bcrypt, express }) {
  const router = express.Router();
  const wrap = (fn) => (req, res) => fn(req, res).catch(err => {
    console.error('[auth] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'サーバーエラーが発生しました' });
  });

  const sessionUser = (u) => ({
    id: u.id,
    name: u.display_name || u.name || u.login_id || 'ユーザー',
    login_id: u.login_id,
    role: u.role,
    area: u.area || '東京',
    mfa_enabled: !!u.mfa_enabled,
    token: signToken({ u: u.id, p: 'session' }, SESSION_TTL_MS),
  });

  const getUserById = async (id) => (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0];

  // ロック確認 / 失敗記録 / 成功リセット（パスワードとコードの失敗を合算）
  const lockedMessage = (u) => {
    if (u.login_locked_until && new Date(u.login_locked_until) > new Date()) {
      const min = Math.ceil((new Date(u.login_locked_until) - Date.now()) / 60000);
      return `ログインの失敗が続いたため一時的にロックされています。約${min}分後にもう一度お試しください`;
    }
    return null;
  };
  async function recordFail(u) {
    const count = (u.login_fail_count || 0) + 1;
    if (count >= MAX_FAILS) {
      await pool.query('UPDATE users SET login_fail_count=0, login_locked_until=$2 WHERE id=$1', [u.id, new Date(Date.now() + LOCK_MS)]);
    } else {
      await pool.query('UPDATE users SET login_fail_count=$2 WHERE id=$1', [u.id, count]);
    }
  }
  const resetFails = (u) => pool.query('UPDATE users SET login_fail_count=0, login_locked_until=NULL WHERE id=$1', [u.id]);

  /** 6桁コード or バックアップコードを検証。成功なら true（使用済み処理も実施） */
  async function checkSecondFactor(u, rawCode) {
    const code = String(rawCode || '').trim();
    if (!u.mfa_enabled || !u.mfa_secret) return false;
    if (/^\d{6}$/.test(code)) {
      let secret;
      try { secret = decrypt(u.mfa_secret); } catch (e) { console.error('[auth] secret decrypt failed:', e.message); return false; }
      const step = totpMatch(secret, code);
      if (step === null) return false;
      // 同じコードの使い回し（リプレイ）を防ぐ: 既に使った時間ステップ以前は拒否
      const r = await pool.query(
        'UPDATE users SET mfa_last_step=$2 WHERE id=$1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)', [u.id, step]);
      return r.rowCount === 1;
    }
    // バックアップコード（1回使い切り）
    const h = sha(normBackup(code));
    let list = [];
    try { list = JSON.parse(u.mfa_backup_codes || '[]'); } catch { list = []; }
    if (!list.includes(h)) return false;
    const next = list.filter(x => x !== h);
    const r = await pool.query('UPDATE users SET mfa_backup_codes=$2 WHERE id=$1 AND mfa_backup_codes=$3',
      [u.id, JSON.stringify(next), u.mfa_backup_codes]);
    return r.rowCount === 1;
  }

  // ── ログイン（1段階目: ID＋パスワード）──────────────────────
  router.post('/api/auth/login', wrap(async (req, res) => {
    const { name, password } = req.body || {};
    if (!name || !password) return res.status(400).json({ error: 'ログインIDとパスワードを入力してください' });
    const u = (await pool.query('SELECT * FROM users WHERE login_id=$1', [name])).rows[0];
    if (!u) return res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });

    const lock = lockedMessage(u);
    if (lock) return res.status(429).json({ error: lock });

    const match = await bcrypt.compare(password, u.password).catch(() => false);
    if (!match) {
      await recordFail(u);
      return res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });
    }

    if (u.mfa_enabled) {
      // パスワードは正しい → 2段階目へ（この時点ではまだログイン完了ではない）
      return res.json({ mfa_required: true, mfa_token: signToken({ u: u.id, p: 'mfa' }, MFA_TOKEN_TTL_MS) });
    }
    if (u.role === 'admin') {
      // 管理者は必須: 未設定なら初回設定へ誘導
      return res.json({ mfa_setup_required: true, setup_token: signToken({ u: u.id, p: 'setup' }, SETUP_TOKEN_TTL_MS) });
    }
    await resetFails(u);
    res.json(sessionUser(u));
  }));

  // ── ログイン（2段階目: 認証コード）──────────────────────────
  router.post('/api/auth/mfa/verify', wrap(async (req, res) => {
    const { mfa_token, code } = req.body || {};
    const p = verifyToken(mfa_token, 'mfa');
    if (!p) return res.status(401).json({ error: '有効期限が切れました。最初からログインし直してください', expired: true });
    const u = await getUserById(p.u);
    if (!u) return res.status(401).json({ error: 'ユーザーが見つかりません', expired: true });
    const lock = lockedMessage(u);
    if (lock) return res.status(429).json({ error: lock });

    const ok = await checkSecondFactor(u, code);
    if (!ok) {
      await recordFail(u);
      return res.status(401).json({ error: '認証コードが正しくありません' });
    }
    await resetFails(u);
    res.json(sessionUser(u));
  }));

  /** 設定系API用: 初回設定トークン or ログイン済みトークンから対象ユーザーを特定 */
  async function actorForSetup(req) {
    const b = req.body || {};
    if (b.setup_token) {
      const p = verifyToken(b.setup_token, 'setup');
      return p ? getUserById(p.u) : null;
    }
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const p = m && verifyToken(m[1], 'session');
    return p ? getUserById(p.u) : null;
  }

  // ── 初回設定: QRコード発行 ─────────────────────────────────
  router.post('/api/auth/mfa/setup-start', wrap(async (req, res) => {
    const u = await actorForSetup(req);
    if (!u) return res.status(401).json({ error: '有効期限が切れました。最初からログインし直してください', expired: true });
    if (u.mfa_enabled) return res.status(400).json({ error: 'すでに多要素認証は有効です' });

    const secret = base32Encode(crypto.randomBytes(20));
    await pool.query('UPDATE users SET mfa_secret=$2, mfa_last_step=NULL WHERE id=$1', [u.id, encrypt(secret)]);
    const account = u.login_id || u.id;
    const uri = `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(account)}`
      + `?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    res.json({ qr, secret, account });
  }));

  // ── 初回設定: 6桁コードで確認 → 有効化 → バックアップコード発行 ──
  router.post('/api/auth/mfa/setup-confirm', wrap(async (req, res) => {
    const u = await actorForSetup(req);
    if (!u) return res.status(401).json({ error: '有効期限が切れました。最初からログインし直してください', expired: true });
    if (u.mfa_enabled) return res.status(400).json({ error: 'すでに多要素認証は有効です' });
    if (!u.mfa_secret) return res.status(400).json({ error: '先にQRコードを表示してください' });
    const lock = lockedMessage(u);
    if (lock) return res.status(429).json({ error: lock });

    let secret;
    try { secret = decrypt(u.mfa_secret); } catch { return res.status(400).json({ error: '設定をやり直してください' }); }
    const step = totpMatch(secret, String((req.body || {}).code || '').trim());
    if (step === null) {
      await recordFail(u);
      return res.status(400).json({ error: '認証コードが正しくありません。アプリに表示されている最新の6桁を入力してください' });
    }
    const codes = generateBackupCodes(10);
    await pool.query(
      'UPDATE users SET mfa_enabled=TRUE, mfa_last_step=$2, mfa_backup_codes=$3, login_fail_count=0, login_locked_until=NULL WHERE id=$1',
      [u.id, step, JSON.stringify(codes.map(c => sha(normBackup(c))))]);
    const fresh = await getUserById(u.id);
    res.json({ backup_codes: codes, user: sessionUser(fresh) });
  }));

  // ── ログイン後の本人用: 状態確認 / 解除 / バックアップ再発行 ───
  router.get('/api/mfa/status', wrap(async (req, res) => {
    const u = await getUserById(req.auth.uid);
    let remaining = 0;
    try { remaining = JSON.parse(u.mfa_backup_codes || '[]').length; } catch { /* 0 */ }
    res.json({ enabled: !!u.mfa_enabled, required: u.role === 'admin', backup_remaining: remaining });
  }));

  router.post('/api/mfa/disable', wrap(async (req, res) => {
    const u = await getUserById(req.auth.uid);
    if (u.role === 'admin') return res.status(403).json({ error: '管理者は多要素認証を解除できません' });
    if (!u.mfa_enabled) return res.status(400).json({ error: '多要素認証は有効ではありません' });
    const lock = lockedMessage(u);
    if (lock) return res.status(429).json({ error: lock });
    const { password, code } = req.body || {};
    const pwOk = password && await bcrypt.compare(password, u.password).catch(() => false);
    const codeOk = pwOk && await checkSecondFactor(u, code);
    if (!pwOk || !codeOk) {
      await recordFail(u);
      return res.status(401).json({ error: 'パスワードまたは認証コードが正しくありません' });
    }
    await pool.query('UPDATE users SET mfa_enabled=FALSE, mfa_secret=NULL, mfa_backup_codes=NULL, mfa_last_step=NULL WHERE id=$1', [u.id]);
    res.json({ success: true });
  }));

  router.post('/api/mfa/backup-codes', wrap(async (req, res) => {
    const u = await getUserById(req.auth.uid);
    if (!u.mfa_enabled) return res.status(400).json({ error: '多要素認証は有効ではありません' });
    const lock = lockedMessage(u);
    if (lock) return res.status(429).json({ error: lock });
    // 再発行は「今のアプリの6桁コード」を要求（バックアップコードでは再発行させない）
    if (!/^\d{6}$/.test(String((req.body || {}).code || '').trim()) || !(await checkSecondFactor(u, req.body.code))) {
      await recordFail(u);
      return res.status(401).json({ error: '認証コードが正しくありません' });
    }
    const codes = generateBackupCodes(10);
    await pool.query('UPDATE users SET mfa_backup_codes=$2 WHERE id=$1', [u.id, JSON.stringify(codes.map(c => sha(normBackup(c))))]);
    res.json({ backup_codes: codes });
  }));

  // ── 管理者による他ユーザーの多要素認証リセット（スマホ紛失時）──
  router.post('/api/users/:id/mfa-reset', wrap(async (req, res) => {
    if (req.params.id === req.auth.uid) return res.status(400).json({ error: '自分自身の多要素認証はリセットできません（他の管理者に依頼してください）' });
    const t = await getUserById(req.params.id);
    if (!t) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    await pool.query(
      'UPDATE users SET mfa_enabled=FALSE, mfa_secret=NULL, mfa_backup_codes=NULL, mfa_last_step=NULL, login_fail_count=0, login_locked_until=NULL WHERE id=$1', [t.id]);
    console.log(`[auth] MFA reset: target=${t.login_id} by=${req.auth.uid}`);
    res.json({ success: true });
  }));

  // ── 全 /api 共通のガード ────────────────────────────────────
  const PUBLIC = new Set(['/health', '/auth/login', '/auth/mfa/verify', '/auth/mfa/setup-start', '/auth/mfa/setup-confirm']);
  const isAdminOnly = (method, p) => {
    if (/^\/admins(\/|$)/.test(p)) return true;
    if (/^\/settings(\/|$)/.test(p)) return true;
    if (/^\/users\/[^/]+\/mfa-reset$/.test(p)) return true;
    if (method !== 'GET' && /^\/(users|cs-members|blocked-dates)(\/|$)/.test(p)) return true;
    return false;
  };
  async function guard(req, res, next) {
    if (PUBLIC.has(req.path)) return next();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const p = m && verifyToken(m[1], 'session');
    if (!p) return res.status(401).json({ error: 'ログインの有効期限が切れました。もう一度ログインしてください', auth: true });
    try {
      const u = await pool.query('SELECT role FROM users WHERE id=$1', [p.u]);
      if (!u.rows[0]) return res.status(401).json({ error: 'ログインの有効期限が切れました。もう一度ログインしてください', auth: true });
      req.auth = { uid: p.u, role: u.rows[0].role };
    } catch (err) {
      console.error('[auth] guard error:', err);
      return res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
    if (isAdminOnly(req.method, req.path) && req.auth.role !== 'admin') {
      return res.status(403).json({ error: 'この操作は管理者のみ可能です' });
    }
    next();
  }

  return { router, guard };
}

module.exports = { createAuth, _test: { totpMatch, hotp, base32Encode, base32Decode, encrypt, decrypt, signToken, verifyToken } };
