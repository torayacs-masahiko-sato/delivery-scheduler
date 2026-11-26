const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
// ID生成は Node 標準の crypto.randomUUID を使用（外部ライブラリ uuid の脆弱性対応で置き換え。生成されるIDの形式は従来と同じ）
const uuidv4 = () => require('crypto').randomUUID();
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const bcrypt = require('bcryptjs');
const { createAuth } = require('./auth');

const app = express();

// ── 非同期処理のエラーを捕捉 ─────────────────────────────────
// Express 4 は async 関数内のエラーを自動では受け取らず、そのままだとアプリが停止する。
// app.get/post/put/delete に登録する全ての処理を包み、エラーは末尾のエラー処理（500/400応答）へ回す。
for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
  const original = app[method].bind(app);
  app[method] = (path, ...handlers) => {
    if (!handlers.length) return original(path); // app.get('設定名') は設定値の取得なので対象外
    return original(path, ...handlers.map(h => (typeof h === 'function' && h.length < 4)
      ? (req, res, next) => { try { const r = h(req, res, next); if (r && typeof r.catch === 'function') r.catch(next); } catch (e) { next(e); } }
      : h));
  };
}
const PORT = process.env.PORT || 3001;

// ── Node.js バージョン確認（2026年10月21日のセキュリティ修正版以上か）────────
// 対象: CVE-2026-111497（Brotli展開の不具合によるリモートコード実行）ほか計10件。
// 修正版: 22.23.4 / 24.22.1 / 26.12.1 以上。20.x 以前はサポート終了で修正版なし。
// 古い場合も停止はさせず（業務を止めないため）、ログに目立つ警告を出す。
(function checkNodeVersion() {
  const PATCHED = { 22: [22, 23, 4], 24: [24, 22, 1], 26: [26, 12, 1] };
  const cur = process.versions.node.split('.').map(Number);
  const min = PATCHED[cur[0]];
  const gte = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
  const ok = min ? gte(cur, min) : cur[0] > 26;
  if (ok) console.log(`🛡 Node.js ${process.version}（セキュリティ修正済みバージョン）`);
  else console.error(`🚨 Node.js ${process.version} は脆弱性修正前のバージョンです。22.23.4 / 24.22.1 / 26.12.1 以上へ更新してください（.node-version を確認）`);
})();

// 外部（Gmail API）からの応答をBrotli圧縮で受け取らないよう指定（多層防御）。
// gzip/deflate のみ受け付ける。Node本体を更新すれば不要だが、念のため。
google.options({ headers: { 'Accept-Encoding': 'gzip, deflate' } });

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
// DB側の再起動・通信の瞬断で「待機中の接続」が切れたときのエラー。
// これを受け取らないとアプリ全体が停止するため、ログだけ残して継続する（次の処理で自動的に再接続される）
pool.on('error', (err) => console.error('[DB] 待機中の接続でエラー（自動で再接続します）:', err.message));
// 想定外のエラーでアプリ全体が止まらないようにする最後の安全網（原因調査用にログは残す）
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

// ── アプリのベースURL（メール内の直接リンク生成に使用） ────────
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://delivery-scheduler-c4cd.onrender.com').replace(/\/$/, '');
// 案件の詳細ページへの直接リンクを生成（ログイン後に自動でその案件を開く）
function buildDetailUrl(projectId) {
  return `${APP_BASE_URL}/?p=${projectId}`;
}

// ── Email helpers ─────────────────────────────────────────────
async function getEmailSettings() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key='email_settings'");
  if (!rows[0]) return { provider: 'gmail_api', from: '', notify_emails: [], gmail_user: '', gmail_app_password: '' };
  return JSON.parse(rows[0].value);
}

// ── Gmail API（OAuth2）でメール送信 ──────────────────────────
async function sendViaGmailApi({ to, subject, html }) {
  const clientId     = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  const senderAddr   = process.env.GMAIL_SENDER_ADDRESS;

  if (!clientId || !clientSecret || !refreshToken || !senderAddr) {
    console.log('[GmailAPI] 環境変数が未設定 — スキップ');
    return { skipped: true, reason: 'env_not_set' };
  }

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const toList = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!toList.length) return { skipped: true, reason: 'no_recipients' };

  // 日本語文字列を RFC 2047 encoded-word に変換
  const encodeHeader = (str) => `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;

  // base64 を RFC 2822 準拠の76文字改行付きに整形
  const foldBase64 = (b64) => b64.match(/.{1,76}/g).join('\r\n');

  const boundary = `boundary_${Date.now()}`;
  const plainText = subject; // プレーンテキスト代替
  const htmlBase64  = foldBase64(Buffer.from(html, 'utf8').toString('base64'));
  const plainBase64 = foldBase64(Buffer.from(plainText, 'utf8').toString('base64'));

  // 差出人名を RFC 2047 でエンコード（文字化け対策）
  const fromHeader = `From: ${encodeHeader('納品スケジューラー')} <${senderAddr}>`;
  const subjectHeader = `Subject: ${encodeHeader(subject)}`;

  const mime = [
    fromHeader,
    `To: ${toList.join(', ')}`,
    subjectHeader,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    plainBase64,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    htmlBase64,
    ``,
    `--${boundary}--`,
  ].join('\r\n');

  // base64url エンコード（RFC 4648）
  const encoded = Buffer.from(mime, 'utf8')
    .toString('base64')
    .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');

  try {
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    console.log('[GmailAPI sent]', subject, '->', toList.join(', '));
    return { success: true };
  } catch (e) {
    console.error('[GmailAPI error]', e.message);
    return { error: e.message };
  }
}

// ── Email templates ───────────────────────────────────────────
const DEFAULT_TEMPLATES = {
  schedule_proposed: {
    subject: '【新規依頼】{{project_type}}（{{client_name}}）',
    body: `新しい案件依頼が届きました。

案件内容：{{project_type}}
顧客名：{{client_name}}
担当営業：{{sales_rep}}
納品方法：{{delivery_method}}
案件ID：{{case_id}}
希望候補日数：{{candidate_days}}日
備考：{{memo}}

候補日をカレンダーで確認して設定してください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  candidates_set: {
    subject: '【仮スケジュール設定完了】{{project_type}}（{{client_name}}）',
    body: `候補日が設定されました。

案件内容：{{project_type}}
顧客名：{{client_name}}
担当営業：{{sales_rep}}
納品方法：{{delivery_method}}
案件ID：{{case_id}}
CS担当者：{{cs_members}}

▼候補日一覧
{{candidate_list}}

担当営業は候補日の中から日程を確定してください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  schedule_confirmed: {
    subject: '【日程確定】{{project_type}}（{{client_name}}）',
    body: `スケジュールが確定しました。

案件内容：{{project_type}}
顧客名：{{client_name}}
担当営業：{{sales_rep}}
案件ID：{{case_id}}
確定日時：{{confirmed_date}}
この日程のCS担当者：{{cs_members}}
納品方法：{{delivery_method}}
{{shortage_reason_line}}

日程が確定しました。準備をお願いします。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  schedule_cancelled: {
    subject: '【キャンセル】{{project_type}}（{{client_name}}）',
    body: `案件がキャンセルされました。

案件内容：{{project_type}}
顧客名：{{client_name}}
案件ID：{{case_id}}
担当営業：{{sales_rep}}
確定日：{{confirmed_date}}
この日程のCS担当者：{{cs_members}}
キャンセル理由：{{cancel_reason}}

再スケジュールが必要な場合は新規案件として再申請してください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  reminder: {
    subject: '【リマインド】仮スケジュール日程未設定：{{project_type}}（{{client_name}}）',
    body: `仮スケジュール未設定のリマインドです。

案件内容：{{project_type}}
顧客名：{{client_name}}
案件ID：{{case_id}}
担当営業：{{sales_rep}}
希望候補日数：{{candidate_days}}日
依頼日：{{created_at}}

候補日が未設定のままです。早急にスケジュールを設定してください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  auto_cancel_warning: {
    subject: '【警告】明日自動キャンセル予定：{{project_type}}（{{client_name}}）',
    body: `⚠️ 明日自動キャンセルされます。

案件内容：{{project_type}}
顧客名：{{client_name}}
担当営業：{{sales_rep}}
自動キャンセル日：{{deadline_date}}
理由：仮スケジュール設定から10営業日経過

本日中にスケジュールを確定するか、担当者に連絡してください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  auto_cancelled: {
    subject: '【自動キャンセル】{{project_type}}（{{client_name}}）',
    body: `案件が自動キャンセルされました。

案件内容：{{project_type}}
顧客名：{{client_name}}
担当営業：{{sales_rep}}
キャンセル理由：仮スケジュール設定から10営業日経過のため自動キャンセル

再スケジュールが必要な場合は新規案件として再申請してください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  cs_members_changed: {
    subject: '【CS担当変更】{{project_type}}（{{client_name}}）',
    body: `確定済み案件のCS担当者が変更されました。

案件内容：{{project_type}}
顧客名：{{client_name}}
案件ID：{{case_id}}
担当営業：{{sales_rep}}
確定日時：{{confirmed_date}}
変更前のCS担当：{{old_cs_members}}
変更後のCS担当：{{new_cs_members}}

引き継ぎが必要な場合は担当者間でご連絡ください。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  confirm_reminder: {
    subject: '【催促】候補日から日程確定をお願いします（{{project_type}}・{{client_name}}）',
    body: `候補日が設定されています。ご都合の良い日程を選択し、確定をお願いします。

案件内容：{{project_type}}
顧客名：{{client_name}}
案件ID：{{case_id}}
担当営業：{{sales_rep}}
希望候補日数：{{candidate_days}}日

▼候補日一覧
{{candidate_list}}

お早めのご確認・日程確定をお願いいたします。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  project_message: {
    subject: '【新着メッセージ】{{project_type}}（{{client_name}}）',
    body: `案件にメッセージが届きました。

案件内容：{{project_type}}
顧客名：{{client_name}}
案件ID：{{case_id}}
担当営業：{{sales_rep}}
送信者：{{sender_name}}

▼メッセージ内容
{{message_body}}

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
  schedule_changed: {
    subject: '【日程変更】{{project_type}}（{{client_name}}）',
    body: `確定済み案件の日程が管理者により変更されました。

案件内容：{{project_type}}
顧客名：{{client_name}}
案件ID：{{case_id}}
担当営業：{{sales_rep}}
CS担当：{{cs_members}}
変更前の日時：{{old_confirmed_date}}
変更後の日時：{{new_confirmed_date}}

予定の変更をお願いします。

▼ 下のボタンからこの案件をすぐに確認できます（ログイン後、自動でこの案件が開きます）`
  },
};

async function getEmailTemplates() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key='email_templates'");
  if (!rows[0]) return DEFAULT_TEMPLATES;
  return { ...DEFAULT_TEMPLATES, ...JSON.parse(rows[0].value) };
}

function renderTemplate(str, vars) {
  return (str || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// HTMLの特殊文字を無害化（顧客名やメッセージに書かれたタグ・リンクをそのまま表示させない）
const escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function textToHtml(title, bodyText, ctaUrl) {
  const bodyHtml = (bodyText || '').split('\n').map(l => l.trim() === '' ? '<br>' : `<div style="margin:2px 0">${escapeHtml(l)}</div>`).join('');
  const ctaHtml = ctaUrl ? `
    <div style="padding:4px 28px 28px">
      <a href="${escapeHtml(ctaUrl)}" style="display:block;text-align:center;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 20px;border-radius:10px">
        この案件を確認する →
      </a>
    </div>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f7fa;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
    <div style="background:#1a2332;padding:24px 28px">
      <div style="color:#3b82f6;font-size:11px;font-weight:700;letter-spacing:0.1em;margin-bottom:6px">納品スケジューラー</div>
      <div style="color:#fff;font-size:18px;font-weight:700">${escapeHtml(title)}</div>
    </div>
    <div style="padding:24px 28px;font-size:14px;color:#333;line-height:1.8">${bodyHtml}</div>
    ${ctaHtml}
  </div></body></html>`;
}

async function sendTemplatedEmail(templateKey, to, vars) {
  const templates = await getEmailTemplates();
  const tpl = templates[templateKey] || DEFAULT_TEMPLATES[templateKey];
  if (!tpl) { console.log('[Email skipped - no template]', templateKey); return { skipped: true }; }
  const subject = renderTemplate(tpl.subject, vars);
  const bodyText = renderTemplate(tpl.body, vars);
  const html = textToHtml(subject, bodyText, vars?.detail_url);
  return sendEmail({ to, subject, html });
}

function createGmailSmtpTransport(user, pass) {
  return nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
}

async function sendEmail({ to, subject, html }) {
  const settings = await getEmailSettings();
  const toList = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!toList.length) { console.log('[Email skipped - no recipients]', subject); return { skipped: true }; }

  const provider = settings.provider || 'gmail_api';

  // ① Gmail API（OAuth2）- 最優先・Render無料枠でもポートブロックなし
  if (provider === 'gmail_api') {
    const result = await sendViaGmailApi({ to: toList, subject, html });
    if (result.success) return result;
    if (result.skipped && result.reason === 'env_not_set') {
      console.log('[GmailAPI] 環境変数未設定のためSMTPフォールバック試行');
    } else if (result.error) {
      console.error('[GmailAPI failed]', result.error);
      return result; // API設定済みだがエラー → 呼び出し元に通知
    }
  }

  // ② Gmail SMTP（有料プランまたはローカル開発用）
  if (provider === 'gmail_smtp') {
    const { gmail_user, gmail_app_password } = settings;
    if (!gmail_user || !gmail_app_password) { console.log('[SMTP skipped - not configured]'); return { skipped: true }; }
    try {
      await createGmailSmtpTransport(gmail_user, gmail_app_password).sendMail({
        from: `"納品スケジューラー" <${gmail_user}>`, to: toList, subject, html,
      });
      console.log('[SMTP sent]', subject); return { success: true };
    } catch (e) { console.error('[SMTP error]', e.message); return { error: e.message }; }
  }

  // ③ Resend API（独自ドメイン必要）
  if (provider === 'resend') {
    const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    if (!resend) { console.log('[Resend skipped - no key]'); return { skipped: true }; }
    const from = settings.from || '納品スケジューラー <onboarding@resend.dev>';
    try {
      const r = await resend.emails.send({ from, to: toList, subject, html });
      console.log('[Resend sent]', subject); return r;
    } catch (e) { console.error('[Resend error]', e.message); return { error: e.message }; }
  }

  console.log('[Email skipped - unknown provider]', provider);
  return { skipped: true };
}

// 担当営業のメールアドレスを display_name で取得
async function getSalesEmail(displayName) {
  const { rows } = await pool.query("SELECT email FROM users WHERE display_name=$1 AND role='sales'", [displayName]);
  return rows[0]?.email || null;
}

// CS部員のメールアドレスを取得（display_name の配列から）
async function getCsEmails(csMemberNames) {
  if (!csMemberNames || !csMemberNames.length) return [];
  const { rows } = await pool.query(
    "SELECT email FROM users WHERE display_name = ANY($1) AND email != ''",
    [csMemberNames]
  );
  return rows.map(r => r.email).filter(Boolean);
}

// 管理者通知アドレス + 担当営業 + CS部員 を合算
// 担当営業のエリアを取得
async function getSalesArea(displayName) {
  const { rows } = await pool.query("SELECT area FROM users WHERE display_name=$1 AND role='sales'", [displayName]);
  return rows[0]?.area || null;
}

// エリアに対応する管理者のメールアドレスを取得
async function getAdminEmailsByArea(area) {
  if (!area) {
    // エリア不明の場合は全管理者
    const { rows } = await pool.query("SELECT email FROM users WHERE role='admin' AND email != ''");
    return rows.map(r => r.email).filter(Boolean);
  }
  const { rows } = await pool.query("SELECT email FROM users WHERE role='admin' AND area=$1 AND email != ''", [area]);
  return rows.map(r => r.email).filter(Boolean);
}

async function buildRecipients(salesDisplayName, csMemberNames) {
  const settings = await getEmailSettings();
  const salesEmail = await getSalesEmail(salesDisplayName);
  const csEmails = await getCsEmails(csMemberNames || []);
  // 担当営業のエリアに対応する管理者メールを取得
  const salesArea = await getSalesArea(salesDisplayName);
  const adminEmails = await getAdminEmailsByArea(salesArea);
  return [...new Set([
    ...(settings.notify_emails || []),  // 管理者通知アドレス（設定画面）
    ...adminEmails,                      // エリア別管理者のメールアドレス
    ...(salesEmail ? [salesEmail] : []), // 担当営業
    ...csEmails,                         // CS部員
  ])].filter(Boolean);
}

// 日本時間での日付文字列（YYYY-MM-DD）。サーバー（Render）は世界標準時で動いているため、日付判定は必ずこれを使う
function jstDateStr(date = new Date()) {
  return new Date(date).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
// 日付文字列（YYYY-MM-DD）に土日を除いた営業日を足す（祝日は考慮しない＝従来どおり）
function addBusinessDaysStr(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  let added = 0;
  while (added < days) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return dt.toISOString().slice(0, 10);
}
function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return d;
}
const DELIVERY_LABEL = (m) => m === 'onsite' ? '🚗 現地訪問' : '🖥 リモート';

// 案件ID採番：DS-YYYYMM-NNNN（月ごと連番）
// case_id_counters テーブルで永続的にカウンターを管理し、案件が削除されても
// 「最終採番＋１」を維持する（歯抜けになった番号を再利用しない）
async function generateCaseId() {
  // 案件IDの年月は日本時間で決める（世界標準時だと毎月1日の朝9時まで前月の番号になるため）
  const [yy, mm] = jstDateStr().split('-');
  const prefix = 'DS-' + yy + mm;

  // このprefixのカウンターがまだ無い場合、既存データの最大採番済み番号から初期化する
  // （導入前に発行済みの案件IDと重複しないようにするための移行措置）
  const { rows: existingMax } = await pool.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(case_id FROM '-(\\d+)$') AS INTEGER)), 0) AS max_seq
     FROM projects WHERE case_id LIKE $1`,
    [prefix + '%']
  );
  await pool.query(
    `INSERT INTO case_id_counters (prefix, last_seq) VALUES ($1, $2) ON CONFLICT (prefix) DO NOTHING`,
    [prefix, existingMax[0].max_seq || 0]
  );

  // 採番は必ずカウンターをインクリメントして取得する（案件テーブルの現在の件数には依存しない）
  const { rows } = await pool.query(
    `UPDATE case_id_counters SET last_seq = last_seq + 1 WHERE prefix=$1 RETURNING last_seq`,
    [prefix]
  );
  const seq = String(rows[0].last_seq).padStart(4, '0');
  return `${prefix}-${seq}`;
}

// ── DB Init ───────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        role         TEXT NOT NULL DEFAULT 'sales',
        password     TEXT NOT NULL,
        email        TEXT DEFAULT '',
        display_name TEXT,
        login_id     TEXT,
        area         TEXT DEFAULT '東京'
      );
      CREATE TABLE IF NOT EXISTS projects (
        id              TEXT PRIMARY KEY,
        case_id         TEXT,
        client_name     TEXT NOT NULL,
        project_type    TEXT NOT NULL DEFAULT '新規納品',
        sales_rep       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        memo            TEXT DEFAULT '',
        client_url      TEXT DEFAULT '',
        delivery_method TEXT DEFAULT 'remote',
        candidate_days  INTEGER DEFAULT 1,
        confirmed_date  TEXT,
        cancel_reason   TEXT DEFAULT '',
        scheduled_at    TIMESTAMPTZ,
        cs_members      TEXT DEFAULT '[]',
        shortage_reason TEXT DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_passkeys (
        id            TEXT PRIMARY KEY,            -- 端末が発行した認証情報ID
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        public_key    TEXT NOT NULL,               -- 公開鍵のみ保存（生体情報は保存しない）
        counter       BIGINT NOT NULL DEFAULT 0,
        transports    TEXT DEFAULT '[]',
        device_name   TEXT DEFAULT '',
        backed_up     BOOLEAN DEFAULT FALSE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_user_passkeys_user ON user_passkeys(user_id);
      CREATE TABLE IF NOT EXISTS project_messages (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        sender_login_id TEXT DEFAULT '',
        sender_name     TEXT NOT NULL,
        sender_role     TEXT NOT NULL DEFAULT 'sales',
        body            TEXT NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS schedule_candidates (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        candidate_date    TEXT NOT NULL,
        candidate_date_to TEXT DEFAULT '',
        candidate_time    TEXT DEFAULT '',
        label             TEXT,
        cs_members        TEXT DEFAULT '[]',
        sales_rep         TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS blocked_dates (
        id         TEXT PRIMARY KEY,
        date       TEXT NOT NULL,
        time_from  TEXT DEFAULT '',
        time_to    TEXT DEFAULT '',
        reason     TEXT DEFAULT '',
        area       TEXT NOT NULL DEFAULT '東京',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS case_id_counters (
        prefix   TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Migrations
    await client.query(`ALTER TABLE projects ALTER COLUMN project_name DROP NOT NULL`).catch(() => {});
    // name カラムの UNIQUE 制約を削除（login_id で一意管理するため）
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_name_key`).catch(() => {});
    await client.query(`ALTER TABLE users ALTER COLUMN name DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS delivery_method TEXT DEFAULT 'remote'`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT DEFAULT '新規納品'`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS candidate_days INTEGER DEFAULT 1`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS cancel_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS cs_members TEXT DEFAULT '[]'`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS shortage_reason TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_id TEXT`);
    await client.query(`UPDATE users SET display_name = name WHERE display_name IS NULL`);
    await client.query(`UPDATE users SET display_name = login_id WHERE display_name IS NULL OR display_name = ''`).catch(() => {});
    await client.query(`UPDATE users SET name = display_name WHERE name IS NULL OR name = ''`).catch(() => {});
    await client.query(`UPDATE users SET login_id = name WHERE login_id IS NULL`);
    await client.query(`ALTER TABLE users ADD CONSTRAINT users_login_id_unique UNIQUE (login_id)`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS area TEXT DEFAULT '東京'`);
    // ── 多要素認証（TOTP）用の列。シークレットはアプリ側で暗号化して保存 ──
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_backup_codes TEXT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_fail_count INT DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_locked_until TIMESTAMPTZ`);
    await client.query(`ALTER TABLE blocked_dates ADD COLUMN IF NOT EXISTS area TEXT NOT NULL DEFAULT '東京'`);
    await client.query(`ALTER TABLE schedule_candidates ADD COLUMN IF NOT EXISTS candidate_date_to TEXT DEFAULT ''`);
    await client.query(`ALTER TABLE schedule_candidates ADD COLUMN IF NOT EXISTS cs_members TEXT DEFAULT '[]'`);
    await client.query(`ALTER TABLE schedule_candidates ADD COLUMN IF NOT EXISTS sales_rep TEXT DEFAULT ''`);
    // 既存の候補日に sales_rep が未設定の場合、案件の担当営業を初期値として引き継ぐ
    await client.query(`
      UPDATE schedule_candidates sc SET sales_rep = p.sales_rep
      FROM projects p WHERE sc.project_id = p.id AND (sc.sales_rep IS NULL OR sc.sales_rep = '')
    `).catch(() => {});
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS case_id TEXT`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_url TEXT DEFAULT ''`);
    // 依頼した営業（案件登録時の担当営業）。日程確定で担当営業が別の人に変わっても、
    // 依頼した本人が引き続き案件・メッセージを見られるようにするため
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS requested_by TEXT`);
    await client.query(`UPDATE projects SET requested_by = sales_rep WHERE requested_by IS NULL`);
    // 自動キャンセルの事前警告を送った日時（同じ案件に警告メールを何度も送らないため）
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_cancel_warned_at TIMESTAMPTZ`);
    // パスワード変更日時（これより前に発行されたログインを無効にするため）
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`);
    // 【A案】仮スケ設定済みなのに自動キャンセルの起点日時が空の案件（不具合で保存されていなかった分）は、
    // この修正版を反映した日時を起点にする → 反映日から10営業日の猶予。
    // 起点が入った案件は対象外になるので、再起動のたびに起点が延びることはない
    const backfill = await client.query(
      `UPDATE projects SET scheduled_at = NOW() WHERE status = 'scheduled' AND scheduled_at IS NULL`);
    if (backfill.rowCount) console.log(`⏱ 自動キャンセルの起点を補完: ${backfill.rowCount}件（反映日から10営業日）`);
    // 関連URL（複数）：[{url, label}] をJSON文字列で保存。label は「契約場所」「納品場所」などのコメント
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_urls TEXT DEFAULT '[]'`);
    // 旧「顧客情報URL」（1件のみ）を、コメント「顧客情報」付きで新しい形式へ引き継ぐ（未移行の案件のみ・何度実行しても安全）
    await client.query(`
      UPDATE projects
         SET client_urls = json_build_array(json_build_object('url', client_url, 'label', '顧客情報'))::text
       WHERE COALESCE(client_url, '') <> '' AND COALESCE(client_urls, '[]') IN ('', '[]')
    `);
    // 既存の case_id が NULL のプロジェクトに連番IDを付与（後方互換）
    await client.query(`
      UPDATE projects SET case_id = 'DS-' ||
        TO_CHAR(created_at, 'YYYYMM') || '-' ||
        LPAD(ROW_NUMBER() OVER (PARTITION BY TO_CHAR(created_at,'YYYYMM') ORDER BY created_at)::TEXT, 4, '0')
      WHERE case_id IS NULL OR case_id = ''
    `).catch(() => {});

    const { rows } = await client.query('SELECT COUNT(*) as c FROM users');
    if (parseInt(rows[0].c) === 0) {
      const hashedAdmin  = await bcrypt.hash('admin123', 10);
      const hashedYamada = await bcrypt.hash('sales123', 10);
      const hashedTanaka = await bcrypt.hash('sales456', 10);
      await client.query(
        `INSERT INTO users (id,name,display_name,login_id,role,password,email,area) VALUES
         ($1,'管理者','管理者','admin','admin',$4,'','東京'),
         ($2,'営業 山田','山田 太郎','yamada','sales',$5,'','東京'),
         ($3,'営業 田中','田中 一郎','tanaka','sales',$6,'','大阪')`,
        [uuidv4(), uuidv4(), uuidv4(), hashedAdmin, hashedYamada, hashedTanaka]
      );
    }
    const { rows: sets } = await client.query("SELECT key FROM settings WHERE key='email_settings'");
    if (!sets[0]) {
      await client.query("INSERT INTO settings (key,value) VALUES ('email_settings',$1)",
        [JSON.stringify({ provider: 'gmail', from: '', notify_emails: [], gmail_user: '', gmail_app_password: '' })]);
    }

    // ── 既存の平文パスワードを bcrypt ハッシュへ自動移行 ──────────
    // bcryptハッシュは必ず $2a$ / $2b$ / $2y$ で始まる。それ以外は平文とみなして変換する。
    const { rows: plainPwUsers } = await client.query(
      `SELECT id, password FROM users WHERE password IS NOT NULL AND password !~ '^\\$2[aby]\\$'`
    );
    for (const u of plainPwUsers) {
      const hashed = await bcrypt.hash(u.password, 10);
      await client.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, u.id]);
    }
    if (plainPwUsers.length > 0) {
      console.log(`🔒 ${plainPwUsers.length}件の平文パスワードをbcryptハッシュへ移行しました`);
    }

    // ── RLS（Row Level Security）を全テーブルで有効化 ─────────────
    // アプリは postgres ロールで直接接続するため RLS の影響を受けず、動作は変わらない。
    // Supabase の PostgREST 経由の外部アクセスのみをブロックする（Lint: "RLS Disabled in Public" 対策）。
    const rlsTables = ['users', 'projects', 'schedule_candidates', 'blocked_dates', 'settings', 'case_id_counters', 'project_messages', 'user_passkeys'];
    for (const t of rlsTables) {
      await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).catch(e => {
        console.error(`[RLS] ${t} の有効化に失敗:`, e.message);
      });
    }
    console.log('🔒 RLS enabled on all public tables');

    console.log('✅ DB initialized');
  } finally { client.release(); }
}

app.use(cors());
// Brotli（br）圧縮されたリクエスト本文は受け付けない（多層防御）。
// 現在の Express 4 はもともと br を展開しないが、将来のライブラリ更新で展開されるようになっても安全なように明示的に拒否する。
app.use((req, res, next) => {
  const enc = String(req.headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('br')) return res.status(415).json({ error: 'この形式のデータは受け付けられません' });
  next();
});
app.use(express.json({ limit: '100kb' })); // 上限を明示（従来の既定値と同じ）

const CLIENT_BUILD = path.join(__dirname, '../client/dist');
if (fs.existsSync(CLIENT_BUILD)) app.use(express.static(CLIENT_BUILD));

// ── Auth（ログイン・多要素認証・セッション。詳細は server/auth.js）──
// 疎通確認用（認証不要）。スリープ復帰待ちの画面が使う
app.get('/api/health', (_req, res) => res.json({ ok: true }));
const auth = createAuth({ pool, bcrypt, express });
app.use('/api', auth.guard);   // /api は ログイン必須（ログイン系・health のみ例外）。管理者専用操作もここで判定
app.use(auth.router);

// ── ユーザー共通ヘルパー ──────────────────────────────────────
// 同じ表示名の人が他にいるか（同じ表示名の登録は許可している。表示名変更時の案件の付け替え判定に使う）
async function isDisplayNameTaken(displayName, exceptId = null) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE (display_name=$1 OR name=$1) AND ($2::text IS NULL OR id<>$2)', [displayName, exceptId]);
  return rows.length > 0;
}

async function upsertUser(id, { display_name, login_id, password, email, area }) {
  const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
  const { rows: before } = await pool.query('SELECT role, display_name, name FROM users WHERE id=$1', [id]);
  const oldName = before[0]?.display_name || before[0]?.name || '';
  const newName = display_name && display_name.trim() ? display_name.trim() : null;
  // 旧い表示名を他の人も使っている場合、案件がどちらの人のものか区別できないため付け替えない
  const oldNameShared = oldName ? await isDisplayNameTaken(oldName, id) : false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET
        display_name=COALESCE($1,display_name), name=COALESCE($1,name),
        login_id=COALESCE($2,login_id), password=COALESCE($3,password),
        email=COALESCE($4,email), area=COALESCE($5,area),
        password_changed_at=CASE WHEN $3::text IS NOT NULL THEN NOW() ELSE password_changed_at END
       WHERE id=$6`,
      [newName, login_id || null, hashedPassword, email !== undefined ? email : null, area || null, id]
    );
    // 表示名を変えた場合、その名前で結び付いている案件・候補日も新しい名前に付け替える
    // （以前は付け替えておらず、名前を変えると自分の案件が見えなくなり通知メールも届かなかった）
    // ただし同じ表示名の人が他にいる場合は、誰の案件か区別できないため付け替えない
    if (newName && oldName && newName !== oldName && !oldNameShared) {
      const role = before[0].role;
      if (role === 'sales') {
        await client.query('UPDATE projects SET sales_rep=$1 WHERE sales_rep=$2', [newName, oldName]);
        await client.query('UPDATE projects SET requested_by=$1 WHERE requested_by=$2', [newName, oldName]);
        await client.query('UPDATE schedule_candidates SET sales_rep=$1 WHERE sales_rep=$2', [newName, oldName]);
      }
      if (role === 'cs') {
        const swap = (text) => JSON.stringify(parseJsonArray(text).map(n => (n === oldName ? newName : n)));
        const like = '%' + JSON.stringify(oldName) + '%';
        for (const table of ['projects', 'schedule_candidates']) {
          const { rows } = await client.query(`SELECT id, cs_members FROM ${table} WHERE cs_members LIKE $1`, [like]);
          for (const r of rows) await client.query(`UPDATE ${table} SET cs_members=$1 WHERE id=$2`, [swap(r.cs_members), r.id]);
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

// ── 営業 CRUD ─────────────────────────────────────────────────
app.get('/api/users', async (_req, res) => {
  const { rows } = await pool.query("SELECT id,display_name,login_id,email,area,mfa_enabled,(SELECT COUNT(*)::int FROM user_passkeys k WHERE k.user_id=users.id) AS passkey_count FROM users WHERE role='sales' ORDER BY display_name");
  res.json(rows);
});
app.post('/api/users', async (req, res) => {
  const { display_name, login_id, password, email, area } = req.body;
  if (!display_name || !login_id || !password) return res.status(400).json({ error: '表示名・ログインID・パスワードは必須です' });
  const dup = await pool.query('SELECT id FROM users WHERE login_id=$1', [login_id]);
  if (dup.rows[0]) return res.status(400).json({ error: 'このログインIDはすでに使われています' });
  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (id,name,display_name,login_id,role,password,email,area) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, display_name, display_name, login_id, 'sales', hashedPassword, email || '', area || '東京']);
  res.status(201).json({ id, display_name, login_id, role: 'sales', email: email || '', area: area || '東京' });
});
app.put('/api/users/:id', async (req, res) => {
  const { display_name, login_id, password, email, area } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (rows[0].role !== 'sales') return res.status(400).json({ error: '営業アカウントではありません' });
  if (login_id) {
    const dup = await pool.query('SELECT id FROM users WHERE login_id=$1 AND id!=$2', [login_id, req.params.id]);
    if (dup.rows[0]) return res.status(400).json({ error: 'このログインIDはすでに使われています' });
  }
  await upsertUser(req.params.id, { display_name, login_id, password, email, area });
  const { rows: u } = await pool.query('SELECT id,display_name,login_id,email,area FROM users WHERE id=$1', [req.params.id]);
  res.json(u[0]);
});
app.delete('/api/users/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (rows[0].role !== 'sales') return res.status(400).json({ error: '営業アカウントではありません' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── 管理者 CRUD ───────────────────────────────────────────────
app.get('/api/admins', async (_req, res) => {
  const { rows } = await pool.query("SELECT id,display_name,login_id,email,area,mfa_enabled,(SELECT COUNT(*)::int FROM user_passkeys k WHERE k.user_id=users.id) AS passkey_count FROM users WHERE role='admin' ORDER BY display_name");
  res.json(rows);
});
app.post('/api/admins', async (req, res) => {
  const { display_name, login_id, password, email, area } = req.body;
  if (!display_name || !login_id || !password) return res.status(400).json({ error: '表示名・ログインID・パスワードは必須です' });
  const dup = await pool.query('SELECT id FROM users WHERE login_id=$1', [login_id]);
  if (dup.rows[0]) return res.status(400).json({ error: 'このログインIDはすでに使われています' });
  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (id,name,display_name,login_id,role,password,email,area) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, display_name, display_name, login_id, 'admin', hashedPassword, email || '', area || '東京']);
  res.status(201).json({ id, display_name, login_id, role: 'admin', email: email || '', area: area || '東京' });
});
app.put('/api/admins/:id', async (req, res) => {
  const { display_name, login_id, password, email, area } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '管理者が見つかりません' });
  if (rows[0].role !== 'admin') return res.status(400).json({ error: '管理者アカウントではありません' });
  if (login_id) {
    const dup = await pool.query('SELECT id FROM users WHERE login_id=$1 AND id!=$2', [login_id, req.params.id]);
    if (dup.rows[0]) return res.status(400).json({ error: 'このログインIDはすでに使われています' });
  }
  await upsertUser(req.params.id, { display_name, login_id, password, email, area });
  const { rows: u } = await pool.query('SELECT id,display_name,login_id,email,area FROM users WHERE id=$1', [req.params.id]);
  res.json(u[0]);
});
app.delete('/api/admins/:id', async (req, res) => {
  const { rows: all } = await pool.query("SELECT id FROM users WHERE role='admin'");
  if (all.length <= 1) return res.status(400).json({ error: '最後の管理者アカウントは削除できません' });
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '管理者が見つかりません' });
  if (rows[0].role !== 'admin') return res.status(400).json({ error: '管理者アカウントではありません' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── CS部員 CRUD ───────────────────────────────────────────────
app.get('/api/cs-members', async (_req, res) => {
  const { rows } = await pool.query("SELECT id,display_name,login_id,email,area,mfa_enabled,(SELECT COUNT(*)::int FROM user_passkeys k WHERE k.user_id=users.id) AS passkey_count FROM users WHERE role='cs' ORDER BY area, display_name");
  res.json(rows);
});
app.post('/api/cs-members', async (req, res) => {
  const { display_name, login_id, password, email, area } = req.body;
  if (!display_name || !login_id || !password) return res.status(400).json({ error: '表示名・ログインID・パスワードは必須です' });
  const dup = await pool.query('SELECT id FROM users WHERE login_id=$1', [login_id]);
  if (dup.rows[0]) return res.status(400).json({ error: 'このログインIDはすでに使われています' });
  const id = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);
  await pool.query('INSERT INTO users (id,name,display_name,login_id,role,password,email,area) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, display_name, display_name, login_id, 'cs', hashedPassword, email || '', area || '東京']);
  res.status(201).json({ id, display_name, login_id, role: 'cs', email: email || '', area: area || '東京' });
});
app.put('/api/cs-members/:id', async (req, res) => {
  const { display_name, login_id, password, email, area } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'CS部員が見つかりません' });
  if (rows[0].role !== 'cs') return res.status(400).json({ error: 'CS部員のアカウントではありません' });
  if (login_id) {
    const dup = await pool.query('SELECT id FROM users WHERE login_id=$1 AND id!=$2', [login_id, req.params.id]);
    if (dup.rows[0]) return res.status(400).json({ error: 'このログインIDはすでに使われています' });
  }
  await upsertUser(req.params.id, { display_name, login_id, password, email, area });
  const { rows: u } = await pool.query('SELECT id,display_name,login_id,email,area FROM users WHERE id=$1', [req.params.id]);
  res.json(u[0]);
});
app.delete('/api/cs-members/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'CS部員が見つかりません' });
  if (rows[0].role !== 'cs') return res.status(400).json({ error: 'CS部員のアカウントではありません' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── Blocked Dates ─────────────────────────────────────────────
app.get('/api/blocked-dates', async (req, res) => {
  const { area } = req.query;
  const { rows } = area
    ? await pool.query('SELECT * FROM blocked_dates WHERE area=$1 ORDER BY date, time_from', [area])
    : await pool.query('SELECT * FROM blocked_dates ORDER BY date, time_from');
  res.json(rows);
});
app.post('/api/blocked-dates', async (req, res) => {
  const { date, time_from, time_to, reason, area } = req.body;
  if (!date) return res.status(400).json({ error: '日付は必須です' });
  if (!area) return res.status(400).json({ error: 'エリアを選択してください' });
  const id = uuidv4();
  await pool.query('INSERT INTO blocked_dates (id,date,time_from,time_to,reason,area) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, date, time_from || '', time_to || '', reason || '', area]);
  const { rows } = await pool.query('SELECT * FROM blocked_dates WHERE id=$1', [id]);
  res.status(201).json(rows[0]);
});
app.delete('/api/blocked-dates/:id', async (req, res) => {
  await pool.query('DELETE FROM blocked_dates WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── Conflict check ────────────────────────────────────────────
app.get('/api/schedule/conflicts', async (req, res) => {
  const { date, time, exclude_project_id, area } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  const blockedQ = area ? 'SELECT * FROM blocked_dates WHERE date=$1 AND area=$2' : 'SELECT * FROM blocked_dates WHERE date=$1';
  const { rows: blocked } = await pool.query(blockedQ, area ? [date, area] : [date]);
  const isBlocked = blocked.some(b => {
    if (!b.time_from && !b.time_to) return true;
    if (!time) return true;
    if (b.time_from && time < b.time_from) return false;
    if (b.time_to && time > b.time_to) return false;
    return true;
  });
  const params = [date];
  let extra = '';
  if (time) { params.push(time); extra += ` AND (sc.candidate_time=$${params.length} OR sc.candidate_time='')`; }
  if (exclude_project_id) { params.push(exclude_project_id); extra += ` AND p.id!=$${params.length}`; }
  const { rows } = await pool.query(`
    SELECT DISTINCT p.sales_rep FROM schedule_candidates sc
    JOIN projects p ON sc.project_id=p.id
    WHERE sc.candidate_date=$1 AND p.status NOT IN ('delivered','cancelled') ${extra}
  `, params);
  res.json({ blocked: isBlocked, blockedInfo: isBlocked ? blocked[0] : null, sales_reps: rows.map(r => r.sales_rep) });
});

// ── Email Settings ────────────────────────────────────────────
app.get('/api/settings/email', async (_req, res) => {
  const s = await getEmailSettings();
  const safe = { ...s };
  if (safe.gmail_app_password) safe.gmail_app_password = '********';
  res.json(safe);
});
app.put('/api/settings/email', async (req, res) => {
  const { provider, from, notify_emails, gmail_user, gmail_app_password } = req.body;
  const existing = await getEmailSettings();
  const value = JSON.stringify({
    provider: provider || 'gmail', from: from || '', notify_emails: notify_emails || [], gmail_user: gmail_user || '',
    gmail_app_password: (gmail_app_password && gmail_app_password !== '********') ? gmail_app_password : (existing.gmail_app_password || ''),
  });
  await pool.query("INSERT INTO settings (key,value) VALUES ('email_settings',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [value]);
  res.json({ success: true });
});
app.post('/api/settings/email/test', async (req, res) => {
  const settings = await getEmailSettings();
  if (!settings.notify_emails?.length) return res.status(400).json({ error: '通知先メールアドレスが登録されていません' });
  const providerLabel = { gmail_api: 'Gmail API (OAuth2)', gmail_smtp: 'Gmail SMTP', resend: 'Resend' }[settings.provider] || settings.provider;
  const result = await sendEmail({
    to: settings.notify_emails,
    subject: '【テスト】納品スケジューラー メール設定確認',
    html: textToHtml('メール設定テスト ✅', `送信方式：${providerLabel}\n送信先：${settings.notify_emails.join(', ')}\n\nこのメールはテスト送信です。正常に届いていれば設定は完了です。`),
  });
  if (result?.error) return res.status(500).json({ error: result.error });
  if (result?.skipped) return res.status(400).json({ error: 'メール設定が未完了です（環境変数を確認してください）' });
  res.json({ success: true });
});
app.get('/api/settings/email-templates', async (_req, res) => { res.json(await getEmailTemplates()); });
app.put('/api/settings/email-templates', async (req, res) => {
  await pool.query("INSERT INTO settings (key,value) VALUES ('email_templates',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(req.body)]);
  res.json({ success: true });
});
app.post('/api/settings/email-templates/reset', async (_req, res) => {
  await pool.query("DELETE FROM settings WHERE key='email_templates'");
  res.json(DEFAULT_TEMPLATES);
});

// ── Projects helper ───────────────────────────────────────────
function parseUrlList(p) {
  let list = [];
  try { list = JSON.parse(p.client_urls || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  // 念のため：未移行の旧データ（client_url のみ）も表示できるようにする
  if (!list.length && p.client_url) list = [{ url: p.client_url, label: '顧客情報' }];
  return list;
}
// JSON配列の列を安全に読む（壊れたデータがあってもエラーで止めない）
function parseJsonArray(text) {
  try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function parseProject(p) {
  return { ...p, cs_members: parseJsonArray(p.cs_members), client_urls: parseUrlList(p) };
}
const parseCandidate = (c) => ({ ...c, cs_members: parseJsonArray(c.cs_members) });

// ── 権限判定（ログイン中の本人情報 req.auth で判定。画面から送られた名前は信用しない）──
// 管理者・CS部員：全案件を閲覧可 ／ 営業：自分が担当営業の案件のみ（画面の表示ルールと同じ）
const isAdminReq = (req) => req.auth?.role === 'admin';
const isOwnerReq = (req, p) => req.auth?.role === 'sales' && !!p
  && (p.sales_rep === req.auth.name || p.requested_by === req.auth.name);
// SQL用：営業が「自分の案件」として扱う条件（担当営業 or 依頼した営業）
const OWN_SQL = '(sales_rep=$1 OR requested_by=$1)';
const canViewProject = (req, p) => isAdminReq(req) || req.auth?.role === 'cs' || isOwnerReq(req, p);
const NO_VIEW = { error: 'この案件を表示する権限がありません' };
const NO_EDIT = { error: 'この案件を操作する権限がありません' };

// 希望候補日数のチェック（1〜10の整数）。問題なければ null
function checkCandidateDays(v) {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10) return '希望候補日数は1〜10の数字で指定してください';
  return null;
}
const VALID_STATUSES = ['pending', 'scheduled', 'confirmed', 'delivered', 'cancelled'];

const MAX_URLS = 10;
const MAX_URL_LABEL = 30;
/**
 * 関連URLの入力チェックと整形。
 * 戻り値: { list } または { error }。URLもコメントも空の行は無視する。
 */
function normalizeUrlList(input) {
  if (input === undefined || input === null) return { list: [] };
  if (!Array.isArray(input)) return { error: '関連URLの形式が正しくありません' };
  const list = [];
  for (const row of input) {
    const url = String(row?.url ?? '').trim();
    const label = String(row?.label ?? '').trim();
    if (!url && !label) continue;
    if (!url) return { error: `コメント「${label}」のURLが入力されていません` };
    if (!/^https?:\/\//i.test(url)) return { error: 'URLは http:// または https:// から始めてください' };
    if (url.length > 2000) return { error: 'URLが長すぎます（2000文字以内）' };
    if (label.length > MAX_URL_LABEL) return { error: `URLのコメントは${MAX_URL_LABEL}文字以内で入力してください` };
    list.push({ url, label });
  }
  if (list.length > MAX_URLS) return { error: `関連URLは${MAX_URLS}件まで登録できます` };
  return { list };
}

// ── Projects ──────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  // 営業は自分の担当案件だけを返す（他の営業の顧客情報を渡さない）
  const salesOnly = req.auth.role === 'sales';
  const { rows: projects } = salesOnly
    ? await pool.query(`SELECT * FROM projects WHERE ${OWN_SQL} ORDER BY updated_at DESC`, [req.auth.name])
    : await pool.query('SELECT * FROM projects ORDER BY updated_at DESC');
  const ids = projects.map(p => p.id);
  const { rows: candidates } = ids.length
    ? await pool.query('SELECT * FROM schedule_candidates WHERE project_id = ANY($1) ORDER BY candidate_date', [ids])
    : { rows: [] };
  const candMap = {};
  candidates.forEach(c => { if (!candMap[c.project_id]) candMap[c.project_id] = []; candMap[c.project_id].push(c); });
  res.json(projects.map(p => ({ ...parseProject(p), candidates: (candMap[p.id] || []).map(parseCandidate) })));
});
app.get('/api/projects/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  if (!canViewProject(req, rows[0])) return res.status(403).json(NO_VIEW);
  const { rows: candidates } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  res.json({ ...parseProject(rows[0]), candidates: candidates.map(parseCandidate) });
});

// 新規登録
app.post('/api/projects', async (req, res) => {
  const { client_name, project_type, memo, delivery_method, candidate_days, client_url, client_urls } = req.body;
  // 担当営業：管理者は選択した営業、それ以外（営業・CS）はログイン中の本人（画面の動きと同じ）
  const sales_rep = isAdminReq(req) ? req.body.sales_rep : req.auth.name;
  const daysError = checkCandidateDays(candidate_days);
  if (daysError) return res.status(400).json({ error: daysError });
  if (!client_name?.trim() || !project_type?.trim() || !sales_rep?.trim() || !memo?.trim()) {
    console.error('[POST /projects] 必須項目不足:', { client_name, project_type, sales_rep, memo });
    return res.status(400).json({ error: '必須項目が不足しています（備考は必須です）' });
  }
  if (memo && memo.length > 50) return res.status(400).json({ error: '備考は50文字以内で入力してください' });
  // 関連URL：新形式（client_urls）を優先。旧形式（client_url 1件）で送られてきた場合も受け付ける
  const urlInput = client_urls !== undefined ? client_urls
    : (client_url && client_url.trim() ? [{ url: client_url, label: '顧客情報' }] : []);
  const urls = normalizeUrlList(urlInput);
  if (urls.error) return res.status(400).json({ error: urls.error });
  const id = uuidv4();
  const case_id = await generateCaseId();
  await pool.query(
    `INSERT INTO projects (id,case_id,client_name,project_type,sales_rep,requested_by,memo,client_url,client_urls,delivery_method,candidate_days,status,cs_members) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,'pending','[]')`,
    [id, case_id, client_name, project_type, sales_rep, memo || '',
     urls.list[0]?.url || '',            // 旧項目にも先頭URLを入れておく（互換用）
     JSON.stringify(urls.list), delivery_method || 'remote', candidate_days || 1]
  );
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [id]);
  const project = { ...parseProject(rows[0]), candidates: [] };
  // 管理者通知アドレス ＋ 担当営業へ送信
  const allTo = await buildRecipients(sales_rep, []);
  if (allTo.length) {
    const result = await sendTemplatedEmail('schedule_proposed', allTo, {
      case_id: project.case_id || '', project_type, client_name, sales_rep,
      delivery_method: DELIVERY_LABEL(delivery_method),
      candidate_days: candidate_days || 1, memo: memo || 'なし',
      detail_url: buildDetailUrl(project.id),
    });
    if (result?.error) console.error('[新規依頼メール送信エラー]', result.error);
  }
  res.status(201).json(project);
});

// 更新
app.put('/api/projects/:id', async (req, res) => {
  const { client_name, project_type, sales_rep, memo, client_url, client_urls, delivery_method, candidate_days, cs_members, candidates, status, confirmed_date, shortage_reason } = req.body;
  const daysError = checkCandidateDays(candidate_days);
  if (daysError) return res.status(400).json({ error: daysError });
  if (status !== undefined && !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'ステータスの指定が正しくありません' });
  if (memo !== undefined && !memo?.trim()) return res.status(400).json({ error: '備考は必須です。空にはできません' });
  if (memo && memo.length > 50) return res.status(400).json({ error: '備考は50文字以内で入力してください' });
  // 関連URL：送られてきた場合のみ更新（旧形式 client_url 単体の更新も受け付ける）
  let urlsJson, firstUrl;
  if (client_urls !== undefined || client_url !== undefined) {
    const urlInput = client_urls !== undefined ? client_urls
      : (client_url && client_url.trim() ? [{ url: client_url, label: '顧客情報' }] : []);
    const urls = normalizeUrlList(urlInput);
    if (urls.error) return res.status(400).json({ error: urls.error });
    urlsJson = JSON.stringify(urls.list);
    firstUrl = urls.list[0]?.url || '';
  }
  const { rows: ex } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!ex[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = ex[0];
  // 項目ごとの入力チェック（送られてきた項目だけ）
  if (client_name !== undefined && !String(client_name).trim()) return res.status(400).json({ error: '顧客名を入力してください' });
  if (client_name !== undefined && String(client_name).trim().length > 100) return res.status(400).json({ error: '顧客名は100文字以内で入力してください' });
  if (project_type !== undefined && !String(project_type).trim()) return res.status(400).json({ error: '案件内容を1つ以上選択してください' });
  if (delivery_method !== undefined && !['remote', 'onsite'].includes(delivery_method)) return res.status(400).json({ error: '納品方法の指定が正しくありません' });
  if (sales_rep !== undefined && sales_rep !== p.sales_rep) {
    const { rows: su } = await pool.query("SELECT id FROM users WHERE role='sales' AND display_name=$1", [String(sales_rep).trim()]);
    if (!su[0]) return res.status(400).json({ error: '担当営業は登録済みの営業メンバーから選択してください' });
  }
  if (candidate_days !== undefined) {
    if (!['pending', 'scheduled'].includes(p.status)) {
      return res.status(400).json({ error: '希望候補日数は、候補日待ち・仮スケ設定済みの案件のみ変更できます' });
    }
    const { rows: cc } = await pool.query('SELECT COUNT(*)::int AS c FROM schedule_candidates WHERE project_id=$1', [req.params.id]);
    if (Number(candidate_days) < cc[0].c) {
      return res.status(400).json({ error: `登録済みの候補日（${cc[0].c}件）より少なくはできません` });
    }
  }
  // 管理者以外は「自分が担当営業の案件」の、備考・関連URLなど基本情報のみ変更できる
  if (!isAdminReq(req)) {
    if (!isOwnerReq(req, p)) return res.status(403).json(NO_EDIT);
    const adminOnly = { sales_rep, status, confirmed_date, cs_members, candidates, shortage_reason };
    if (Object.values(adminOnly).some(v => v !== undefined)) {
      return res.status(403).json({ error: '担当営業・ステータス・CS担当者などは管理者のみ変更できます' });
    }
  }
  const csMembersJson = cs_members !== undefined ? JSON.stringify(cs_members) : p.cs_members;
  await pool.query(
    `UPDATE projects SET client_name=$1,project_type=$2,sales_rep=$3,memo=$4,status=$5,confirmed_date=$6,delivery_method=$7,candidate_days=$8,cs_members=$9,client_url=$10,client_urls=$11,shortage_reason=$12,updated_at=NOW() WHERE id=$13`,
    [client_name !== undefined ? String(client_name).trim() : p.client_name,
     project_type !== undefined ? String(project_type).trim() : p.project_type,
     sales_rep !== undefined ? String(sales_rep).trim() : p.sales_rep, memo??p.memo,
     status??p.status, confirmed_date??p.confirmed_date, delivery_method??p.delivery_method, candidate_days??p.candidate_days, csMembersJson,
     firstUrl !== undefined ? firstUrl : p.client_url,
     urlsJson !== undefined ? urlsJson : (p.client_urls || '[]'),
     // 不足理由（候補日が希望日数より少ないまま設定完了するとき）。以前はここで保存されず消えていた
     shortage_reason !== undefined ? String(shortage_reason).trim() : (p.shortage_reason || ''),
     req.params.id]
  );
  if (candidates !== undefined) {
    await pool.query('DELETE FROM schedule_candidates WHERE project_id=$1', [req.params.id]);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      await pool.query('INSERT INTO schedule_candidates (id,project_id,candidate_date,candidate_date_to,candidate_time,label) VALUES ($1,$2,$3,$4,$5,$6)',
        [uuidv4(), req.params.id, c.date, c.date_to || '', c.time || '', `第${i+1}候補`]);
    }
  }
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  const { rows: cands } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  res.json({ ...parseProject(rows[0]), candidates: cands });
});

// 候補日 追加（希望日数上限チェック・ステータスはfinalizeまでpending維持）
app.post('/api/projects/:id/candidates', async (req, res) => {
  const { date, date_to, time, cs_members, sales_rep } = req.body;
  if (!date) return res.status(400).json({ error: '日付は必須です' });
  if (!cs_members || !cs_members.length) return res.status(400).json({ error: 'CS担当者を1名以上選択してください' });
  if (cs_members.length > 2) return res.status(400).json({ error: 'CS担当者は最大2名までです' });
  const { rows: existing } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!existing[0]) return res.status(404).json({ error: '案件が見つかりません' });
  if (['confirmed', 'delivered', 'cancelled'].includes(existing[0].status)) {
    return res.status(400).json({ error: '確定済み・納品済み・キャンセル済みの案件の候補日は変更できません' });
  }
  const maxDays = existing[0].candidate_days || 1;
  const { rows: cands } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1', [req.params.id]);
  if (cands.length >= maxDays) {
    return res.status(400).json({ error: `希望候補日数は${maxDays}日です。${maxDays}件を超えて登録できません。` });
  }
  const csMembersJson = JSON.stringify(cs_members || []);
  // 営業メンバー未指定の場合は案件の担当営業を初期値として使用
  const salesRepVal = (sales_rep && sales_rep.trim()) ? sales_rep : existing[0].sales_rep;
  await pool.query(
    'INSERT INTO schedule_candidates (id,project_id,candidate_date,candidate_date_to,candidate_time,label,cs_members,sales_rep) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [uuidv4(), req.params.id, date, date_to || '', time || '', `第${cands.length+1}候補`, csMembersJson, salesRepVal]
  );
  // ステータスはfinalizeまでpendingのまま維持（scheduledには変更しない）
  await pool.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  res.status(201).json(updated.map(r => ({ ...r, cs_members: JSON.parse(r.cs_members || '[]') })));
});

// 候補日 編集（管理者が設定済みの候補日を修正）
app.put('/api/projects/:id/candidates/:candidateId', async (req, res) => {
  const { date, date_to, time, cs_members, sales_rep } = req.body;
  if (!date) return res.status(400).json({ error: '日付は必須です' });
  if (cs_members !== undefined && (!cs_members.length || cs_members.length > 2)) {
    return res.status(400).json({ error: 'CS担当者は1〜2名で選択してください' });
  }
  const { rows } = await pool.query('SELECT * FROM schedule_candidates WHERE id=$1 AND project_id=$2', [req.params.candidateId, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '候補日が見つかりません' });
  const { rows: existing } = await pool.query('SELECT status FROM projects WHERE id=$1', [req.params.id]);
  if (['confirmed', 'delivered', 'cancelled'].includes(existing[0].status)) {
    return res.status(400).json({ error: '確定済み・納品済み・キャンセル済みの案件の候補日は変更できません' });
  }
  const csMembersJson = cs_members !== undefined ? JSON.stringify(cs_members) : rows[0].cs_members;
  const salesRepVal = sales_rep !== undefined && sales_rep.trim() ? sales_rep : rows[0].sales_rep;
  await pool.query(
    'UPDATE schedule_candidates SET candidate_date=$1, candidate_date_to=$2, candidate_time=$3, cs_members=$4, sales_rep=$5 WHERE id=$6',
    [date, date_to || '', time || '', csMembersJson, salesRepVal, req.params.candidateId]
  );
  await pool.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  res.json(updated.map(r => ({ ...r, cs_members: JSON.parse(r.cs_members || '[]') })));
});

// 候補日 削除
app.delete('/api/projects/:id/candidates/:candidateId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM schedule_candidates WHERE id=$1 AND project_id=$2', [req.params.candidateId, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '候補日が見つかりません' });
  await pool.query('DELETE FROM schedule_candidates WHERE id=$1', [req.params.candidateId]);
  const { rows: remaining } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  for (let i = 0; i < remaining.length; i++) {
    await pool.query('UPDATE schedule_candidates SET label=$1 WHERE id=$2', [`第${i+1}候補`, remaining[i].id]);
  }
  await pool.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  res.json(updated.map(r => ({ ...r, cs_members: JSON.parse(r.cs_members || '[]') })));
});

// 候補日の設定完了（通知メール送信・ステータスをscheduledに変更）
app.post('/api/projects/:id/candidates/finalize', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (!['pending', 'scheduled'].includes(p.status)) {
    return res.status(400).json({ error: '候補日待ち・仮スケ設定済みの案件のみ設定完了できます' });
  }
  const { rows: cands } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  if (cands.length === 0) return res.status(400).json({ error: '候補日が1件も登録されていません' });
  const maxDays = p.candidate_days || 1;
  if (cands.length > maxDays) return res.status(400).json({ error: `希望候補日数（${maxDays}日）を超えています。${cands.length - maxDays}件削除してください。` });
  // すべての候補日にCS担当者が1名以上設定されているか（仮スケジュール決定時の必須条件）
  const missingCs = cands.some(c => {
    try { return JSON.parse(c.cs_members || '[]').length === 0; } catch { return true; }
  });
  if (missingCs) return res.status(400).json({ error: 'すべての候補日にCS担当者を1名以上設定してください' });
  // 候補日不足の場合も shortage_reason が入力済みであれば完了できる（フロントで事前に保存）

  // scheduled_at = 自動キャンセル（10営業日後）の起点。以前はここで保存されておらず、自動キャンセルが動いていなかった。
  // 候補日を出し直した場合も、出し直した日から数え直す（警告済みの記録もリセット）
  const reason = typeof req.body?.shortage_reason === 'string' ? req.body.shortage_reason.trim() : null;
  await pool.query(
    `UPDATE projects SET status='scheduled', scheduled_at=NOW(), auto_cancel_warned_at=NULL,
            shortage_reason=COALESCE($2, shortage_reason), updated_at=NOW() WHERE id=$1`,
    [req.params.id, reason]);

  // 全候補日の CS 部員を合算（重複除去）
  const allCsNames = [...new Set(cands.flatMap(c => {
    try { return JSON.parse(c.cs_members || '[]'); } catch { return []; }
  }))];

  // 合算したCS部員を案件レベルにも保存（確定時に引き継ぐため）
  await pool.query('UPDATE projects SET cs_members=$1 WHERE id=$2', [JSON.stringify(allCsNames), req.params.id]);

  const { rows: updatedProject } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);

  const allTo = await buildRecipients(p.sales_rep, allCsNames);
  if (allTo.length) {
    const dateLines = cands.map(c => {
      const candCs = (() => { try { return JSON.parse(c.cs_members || '[]'); } catch { return []; } })();
      let s = `${c.label}：${c.candidate_date}`;
      if (c.candidate_date_to) s += `〜${c.candidate_date_to}`;
      if (c.candidate_time) s += ` ${c.candidate_time}`;
      if (candCs.length) s += ` （CS担当：${candCs.join('、')}）`;
      return s;
    }).join('\n');
    const csDisplay = allCsNames.length ? allCsNames.join('、') : 'なし';
    await sendTemplatedEmail('candidates_set', allTo, {
      case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
      delivery_method: DELIVERY_LABEL(p.delivery_method),
      cs_members: csDisplay,
      candidate_list: dateLines,
      detail_url: buildDetailUrl(p.id),
    });
  }
  res.json({ ...parseProject(updatedProject[0]), candidates: cands.map(c => ({ ...c, cs_members: JSON.parse(c.cs_members || '[]') })) });
});

// 仮スケジュールを確定（CS部員選択・不足理由）
app.post('/api/projects/:id/confirm-schedule', async (req, res) => {
  const { confirmed_date, confirmed_time, cs_members, shortage_reason, sales_rep } = req.body;
  if (!confirmed_date) return res.status(400).json({ error: '確定日を選択してください' });
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (!isAdminReq(req) && !isOwnerReq(req, p)) return res.status(403).json(NO_EDIT);
  if (!['pending', 'scheduled'].includes(p.status)) {
    return res.status(400).json({ error: 'この案件はすでに確定済み・納品済み・キャンセル済みのため確定できません' });
  }
  const { rows: candCount } = await pool.query('SELECT COUNT(*)::int AS c FROM schedule_candidates WHERE project_id=$1', [req.params.id]);
  if (!candCount[0].c) return res.status(400).json({ error: '候補日が登録されていないため確定できません' });
  const fullDate = confirmed_time ? `${confirmed_date} ${confirmed_time}` : confirmed_date;
  const csMembersArr = Array.isArray(cs_members) ? cs_members : (p.cs_members || []);
  const csMembersJson = JSON.stringify(csMembersArr);
  // 候補日ごとに営業メンバーが指定されていれば、確定時に案件の担当営業として引き継ぐ
  const salesRepVal = (sales_rep && sales_rep.trim()) ? sales_rep : p.sales_rep;

  // 不足理由は finalize 時に既に保存済み（confirm-schedule 時点では不要）

  await pool.query(
    `UPDATE projects SET confirmed_date=$1, status='confirmed', scheduled_at=NOW(), updated_at=NOW(), cs_members=$2, shortage_reason=$3, sales_rep=$4 WHERE id=$5`,
    [fullDate, csMembersJson, shortage_reason || '', salesRepVal, req.params.id]
  );
  await pool.query('DELETE FROM schedule_candidates WHERE project_id=$1', [req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  const project = { ...parseProject(updated[0]), candidates: [] };

  const allTo = await buildRecipients(salesRepVal, csMembersArr);
  if (allTo.length) {
    const shortageReasonLine = shortage_reason?.trim() ? `不足理由：${shortage_reason.trim()}` : '';
    await sendTemplatedEmail('schedule_confirmed', allTo, {
      case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: salesRepVal,
      delivery_method: DELIVERY_LABEL(p.delivery_method),
      cs_members: csMembersArr.length ? csMembersArr.join('、') : 'なし',
      confirmed_date: fullDate, shortage_reason_line: shortageReasonLine,
      detail_url: buildDetailUrl(p.id),
    });
  }
  res.json(project);
});

// 確定済み案件の確定日時を変更（管理者のみ）。notify=true なら担当営業・依頼した営業・CS担当へ変更通知
app.put('/api/projects/:id/confirmed-date', async (req, res) => {
  if (!isAdminReq(req)) return res.status(403).json({ error: 'この操作は管理者のみ可能です' });
  const { date, time, notify } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: '確定日を正しく入力してください' });
  if (time && !/^\d{2}:\d{2}$/.test(String(time))) return res.status(400).json({ error: '時刻を正しく入力してください' });
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (p.status !== 'confirmed') return res.status(400).json({ error: '確定済みの案件のみ確定日時を変更できます' });
  const newDate = time ? `${date} ${time}` : date;   // 日程確定時と同じ形式
  const oldDate = p.confirmed_date || '';
  if (newDate === oldDate) return res.json({ ...p, candidates: [] });
  await pool.query('UPDATE projects SET confirmed_date=$1, updated_at=NOW() WHERE id=$2', [newDate, req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  const project = { ...parseProject(updated[0]), candidates: [] };
  if (notify) {
    try {
      const names = [...new Set([p.sales_rep, p.requested_by].filter(Boolean))];
      const lists = await Promise.all(names.map(n => buildRecipients(n, p.cs_members || [])));
      const allTo = [...new Set(lists.flat())];
      if (allTo.length) {
        await sendTemplatedEmail('schedule_changed', allTo, {
          case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
          cs_members: (p.cs_members || []).join('、') || 'なし',
          old_confirmed_date: oldDate, new_confirmed_date: newDate, detail_url: buildDetailUrl(p.id),
        });
      }
    } catch (e) { console.error('[日程変更メール送信エラー]', e.message); }
  }
  res.json(project);
});

// 確定済み案件のCS担当者を変更（管理者のみ・変更通知メール送信）
app.put('/api/projects/:id/cs-members', async (req, res) => {
  const { cs_members } = req.body;
  if (!cs_members || !cs_members.length) return res.status(400).json({ error: 'CS担当者を1名以上選択してください' });
  if (cs_members.length > 2) return res.status(400).json({ error: 'CS担当者は最大2名までです' });
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (p.status !== 'confirmed') return res.status(400).json({ error: '確定済みの案件のみCS担当者を変更できます' });

  const oldCsMembers = p.cs_members || [];
  const newCsMembers = cs_members;

  await pool.query('UPDATE projects SET cs_members=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(newCsMembers), req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  const project = { ...parseProject(updated[0]), candidates: [] };

  // 変更前後どちらのCS部員にも通知（引き継ぎ漏れ防止）
  const notifyCsNames = [...new Set([...oldCsMembers, ...newCsMembers])];
  const allTo = await buildRecipients(p.sales_rep, notifyCsNames);
  if (allTo.length) {
    await sendTemplatedEmail('cs_members_changed', allTo, {
      case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
      confirmed_date: p.confirmed_date || '—',
      old_cs_members: oldCsMembers.length ? oldCsMembers.join('、') : 'なし',
      new_cs_members: newCsMembers.length ? newCsMembers.join('、') : 'なし',
      detail_url: buildDetailUrl(p.id),
    });
  }
  res.json(project);
});

// キャンセル
app.post('/api/projects/:id/cancel', async (req, res) => {
  const { reason } = req.body;
  if (!reason?.trim()) return res.status(400).json({ error: 'キャンセル理由を入力してください' });
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (!canViewProject(req, p)) return res.status(403).json(NO_EDIT);
  if (['cancelled', 'delivered'].includes(p.status)) {
    return res.status(400).json({ error: 'キャンセル済み・納品済みの案件はキャンセルできません' });
  }
  await pool.query(`UPDATE projects SET status='cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2`, [reason.trim(), req.params.id]);
  await pool.query('DELETE FROM schedule_candidates WHERE project_id=$1', [req.params.id]);
  const { rows: updated } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  const allTo = await buildRecipients(p.sales_rep, p.cs_members);
  if (allTo.length) {
    await sendTemplatedEmail('schedule_cancelled', allTo, {
      case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
      confirmed_date: p.confirmed_date || '未確定',
      cs_members: (p.cs_members && p.cs_members.length) ? p.cs_members.join('、') : 'なし',
      cancel_reason: reason.trim(),
      detail_url: buildDetailUrl(p.id),
    });
  }
  res.json({ ...parseProject(updated[0]), candidates: [] });
});

// リマインド
app.post('/api/projects/:id/remind', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (!isAdminReq(req) && !isOwnerReq(req, p)) return res.status(403).json(NO_EDIT);
  const requester_login_id = req.auth.login_id;
  const settings = await getEmailSettings();
  const salesEmail = await getSalesEmail(p.sales_rep);
  let requesterEmail = null;
  if (requester_login_id) {
    const { rows: r } = await pool.query('SELECT email FROM users WHERE login_id=$1', [requester_login_id]);
    requesterEmail = r[0]?.email || null;
  }
  const allTo = [...new Set([
    ...(settings.notify_emails || []), ...(salesEmail ? [salesEmail] : []), ...(requesterEmail ? [requesterEmail] : []),
  ])].filter(Boolean);
  if (!allTo.length) return res.status(400).json({ error: '送信先メールアドレスが登録されていません。管理者設定でメールアドレスを登録してください。' });
  const result = await sendTemplatedEmail('reminder', allTo, {
    case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
    candidate_days: p.candidate_days || 1,
    created_at: p.created_at ? new Date(p.created_at).toLocaleDateString('ja-JP') : '—',
    detail_url: buildDetailUrl(p.id),
  });
  if (result?.error) return res.status(500).json({ error: result.error });
  if (result?.skipped) return res.status(400).json({ error: 'メール送信設定（Gmail/Resend）が未完了です' });
  res.json({ success: true });
});

// 仮スケジュール設定済みの案件について、管理者が営業担当へ日程確定を催促する
app.post('/api/projects/:id/remind-confirm', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
  if (p.status !== 'scheduled') return res.status(400).json({ error: '仮スケジュール設定済みの案件のみ催促できます' });

  const { rows: cands } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  if (!cands.length) return res.status(400).json({ error: '候補日が登録されていません' });

  const allCsNames = [...new Set(cands.flatMap(c => {
    try { return JSON.parse(c.cs_members || '[]'); } catch { return []; }
  }))];
  const dateLines = cands.map(c => {
    const candCs = (() => { try { return JSON.parse(c.cs_members || '[]'); } catch { return []; } })();
    let s = `${c.label}：${c.candidate_date}`;
    if (c.candidate_date_to) s += `〜${c.candidate_date_to}`;
    if (c.candidate_time) s += ` ${c.candidate_time}`;
    if (candCs.length) s += ` （CS担当：${candCs.join('、')}）`;
    return s;
  }).join('\n');

  const allTo = await buildRecipients(p.sales_rep, allCsNames);
  if (!allTo.length) return res.status(400).json({ error: '送信先メールアドレスが登録されていません。管理者設定でメールアドレスを登録してください。' });

  const result = await sendTemplatedEmail('confirm_reminder', allTo, {
    case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
    candidate_days: p.candidate_days || 1,
    candidate_list: dateLines,
    detail_url: buildDetailUrl(p.id),
  });
  if (result?.error) return res.status(500).json({ error: result.error });
  if (result?.skipped) return res.status(400).json({ error: 'メール送信設定（Gmail/Resend）が未完了です' });
  res.json({ success: true });
});

// ── 案件ごとのメッセージ（営業⇔管理者のやり取り） ──────────────
app.get('/api/projects/:id/messages', async (req, res) => {
  const { rows: proj } = await pool.query('SELECT sales_rep, requested_by FROM projects WHERE id=$1', [req.params.id]);
  if (!proj[0]) return res.status(404).json({ error: '案件が見つかりません' });
  if (!isAdminReq(req) && !isOwnerReq(req, proj[0])) return res.status(403).json(NO_VIEW);
  const { rows } = await pool.query(
    'SELECT * FROM project_messages WHERE project_id=$1 ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json(rows);
});

app.post('/api/projects/:id/messages', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'メッセージを入力してください' });
  if (body.length > 1000) return res.status(400).json({ error: 'メッセージは1000文字以内で入力してください' });
  const { rows: proj } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!proj[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(proj[0]);
  if (!isAdminReq(req) && !isOwnerReq(req, p)) return res.status(403).json(NO_EDIT);
  // 送信者は画面から送られた値ではなく、ログイン中の本人情報を使う（なりすまし防止）
  const sender_name = req.auth.name;
  const sender_role = req.auth.role;
  const sender_login_id = req.auth.login_id;

  const id = uuidv4();
  await pool.query(
    'INSERT INTO project_messages (id,project_id,sender_login_id,sender_name,sender_role,body) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, req.params.id, sender_login_id || '', sender_name.trim(), sender_role || 'sales', body.trim()]
  );
  const { rows: created } = await pool.query('SELECT * FROM project_messages WHERE id=$1', [id]);

  // 送信者が営業なら管理者へ、管理者なら担当営業へ通知メールを送る
  try {
    const settings = await getEmailSettings();
    const salesArea = await getSalesArea(p.sales_rep);
    const adminEmails = await getAdminEmailsByArea(salesArea);
    let allTo = [];
    if (sender_role === 'admin') {
      const names = [...new Set([p.sales_rep, p.requested_by].filter(Boolean))];
      const emails = await Promise.all(names.map(n => getSalesEmail(n)));
      allTo = [...new Set(emails.filter(Boolean))];
    } else {
      allTo = [...new Set([...(settings.notify_emails || []), ...adminEmails])];
    }
    if (allTo.length) {
      await sendTemplatedEmail('project_message', allTo, {
        case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep,
        sender_name: sender_name.trim(), message_body: body.trim(),
        detail_url: buildDetailUrl(p.id),
      });
    }
  } catch (e) { console.error('[メッセージ通知メール送信エラー]', e.message); }

  res.status(201).json(created[0]);
});

async function runAutoCancel() {
  try {
    const { rows: projects } = await pool.query(`SELECT * FROM projects WHERE status='scheduled' AND scheduled_at IS NOT NULL`);
    const todayStr = jstDateStr();                       // 日本時間の今日
    for (const p_ of projects) {
      try {
        const p = parseProject(p_);
        const startStr = jstDateStr(p.scheduled_at);     // 起点日（日本時間）
        const deadlineStr = addBusinessDaysStr(startStr, 10);
        const warningStr = addBusinessDaysStr(startStr, 9);
        if (todayStr >= deadlineStr) {
          // 状態を条件に入れて更新（同時に確定・キャンセルされた案件を誤って上書きしない）
          const r = await pool.query(
            `UPDATE projects SET status='cancelled', cancel_reason='未確定のため（自動キャンセル）', updated_at=NOW()
              WHERE id=$1 AND status='scheduled'`, [p.id]);
          if (!r.rowCount) continue;
          await pool.query('DELETE FROM schedule_candidates WHERE project_id=$1', [p.id]);
          console.log(`[AutoCancel] 自動キャンセル: ${p.case_id}`);
          const allTo = await buildRecipients(p.sales_rep, p.cs_members);
          if (allTo.length) await sendTemplatedEmail('auto_cancelled', allTo, { case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep, detail_url: buildDetailUrl(p.id) });
        } else if (todayStr >= warningStr && !p.auto_cancel_warned_at) {
          // 事前警告は1案件につき1回だけ（以前は警告日の間、1時間ごとに送られる作りだった）。
          // 無料プランでサーバーが休止していて警告日を過ぎても、起動後に1回送る
          const r = await pool.query(
            `UPDATE projects SET auto_cancel_warned_at=NOW() WHERE id=$1 AND auto_cancel_warned_at IS NULL AND status='scheduled'`, [p.id]);
          if (!r.rowCount) continue;
          const allTo = await buildRecipients(p.sales_rep, p.cs_members);
          if (allTo.length) await sendTemplatedEmail('auto_cancel_warning', allTo, { case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep, deadline_date: deadlineStr, detail_url: buildDetailUrl(p.id) });
        }
      } catch (e) { console.error('[AutoCancel] 案件ごとの処理でエラー:', p_.id, e.message); }
    }
  } catch (e) { console.error('[AutoCancel error]', e.message); }
}

app.delete('/api/projects/:id', async (req, res) => {
  // 管理者：全案件 ／ 営業：自分の担当案件のみ ／ CS部員：不可
  const { rows: proj } = await pool.query('SELECT sales_rep, requested_by FROM projects WHERE id=$1', [req.params.id]);
  if (!proj[0]) return res.status(404).json({ error: '案件が見つかりません' });
  if (!isAdminReq(req) && !isOwnerReq(req, proj[0])) return res.status(403).json({ error: '自分が担当する案件のみ削除できます' });
  await pool.query('DELETE FROM projects WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// 選択削除：複数の案件IDを指定して一括削除
app.post('/api/projects/bulk-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(x => typeof x !== 'string')) {
    return res.status(400).json({ error: '削除する案件が選択されていません' });
  }
  if (!isAdminReq(req) && req.auth.role !== 'sales') return res.status(403).json({ error: '案件を削除する権限がありません' });

  // 営業は自分の担当案件IDのみに絞り込む（他人の案件IDが混じっていても無視）
  let targetIds = ids;
  if (!isAdminReq(req)) {
    const { rows: ownedProjects } = await pool.query(
      'SELECT id FROM projects WHERE id = ANY($1) AND (sales_rep=$2 OR requested_by=$2)', [ids, req.auth.name]);
    targetIds = ownedProjects.map(p => p.id);
    if (targetIds.length === 0) {
      return res.status(403).json({ error: '削除できる案件がありません（自分が担当する案件のみ削除できます）' });
    }
  }

  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = ANY($1)', [targetIds]);
  res.json({ success: true, deleted: rowCount });
});

// 一括削除：指定ステータスの案件を全件削除（確定済み／キャンセルのみ許可）
app.post('/api/projects/delete-by-status', async (req, res) => {
  const { status } = req.body;
  const allowedStatuses = ['confirmed', 'cancelled'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'このステータスの一括削除はできません' });
  }
  if (!isAdminReq(req) && req.auth.role !== 'sales') return res.status(403).json({ error: '案件を削除する権限がありません' });

  // 営業は自分の担当案件のみ削除（他営業の案件は対象外）
  if (!isAdminReq(req)) {
    const { rowCount } = await pool.query('DELETE FROM projects WHERE status=$1 AND (sales_rep=$2 OR requested_by=$2)', [status, req.auth.name]);
    return res.json({ success: true, deleted: rowCount });
  }

  const { rowCount } = await pool.query('DELETE FROM projects WHERE status=$1', [status]);
  res.json({ success: true, deleted: rowCount });
});

app.get('/api/stats', async (req, res) => {
  const salesOnly = req.auth.role === 'sales';
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE TRUE) AS total,
           COUNT(*) FILTER (WHERE status='pending') AS pending,
           COUNT(*) FILTER (WHERE status='scheduled') AS scheduled,
           COUNT(*) FILTER (WHERE status='confirmed') AS confirmed,
           COUNT(*) FILTER (WHERE status='delivered') AS delivered
    FROM projects ${salesOnly ? 'WHERE ' + OWN_SQL : ''}
  `, salesOnly ? [req.auth.name] : []);
  const r = rows[0];
  res.json({ total: +r.total, pending: +r.pending, scheduled: +r.scheduled, confirmed: +r.confirmed, delivered: +r.delivered });
});

app.get('*', (_req, res) => {
  if (fs.existsSync(CLIENT_BUILD)) res.sendFile(path.join(CLIENT_BUILD, 'index.html'));
  else res.json({ message: 'API running' });
});

// ── エラー処理（どのAPIで起きたエラーもここで応答し、アプリは止めない）──
app.use((err, req, res, _next) => {
  console.error(`[API error] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  // 22xxx = 入力値の形式エラー（数値欄に文字など）→ 利用者の入力ミスとして 400 を返す
  if (err.type === 'entity.parse.failed' || (typeof err.code === 'string' && err.code.startsWith('22'))) {
    return res.status(400).json({ error: '入力内容の形式が正しくありません' });
  }
  res.status(500).json({ error: 'サーバーでエラーが発生しました。時間をおいてもう一度お試しください' });
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
  setInterval(runAutoCancel, 60 * 60 * 1000);
  runAutoCancel();
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
