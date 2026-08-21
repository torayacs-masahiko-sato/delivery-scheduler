const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { Resend } = require('resend');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3001;

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

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
};

async function getEmailTemplates() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key='email_templates'");
  if (!rows[0]) return DEFAULT_TEMPLATES;
  return { ...DEFAULT_TEMPLATES, ...JSON.parse(rows[0].value) };
}

function renderTemplate(str, vars) {
  return (str || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function textToHtml(title, bodyText, ctaUrl) {
  const bodyHtml = (bodyText || '').split('\n').map(l => l.trim() === '' ? '<br>' : `<div style="margin:2px 0">${l}</div>`).join('');
  const ctaHtml = ctaUrl ? `
    <div style="padding:4px 28px 28px">
      <a href="${ctaUrl}" style="display:block;text-align:center;background:#3b82f6;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 20px;border-radius:10px">
        この案件を確認する →
      </a>
    </div>` : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f7fa;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
    <div style="background:#1a2332;padding:24px 28px">
      <div style="color:#3b82f6;font-size:11px;font-weight:700;letter-spacing:0.1em;margin-bottom:6px">納品スケジューラー</div>
      <div style="color:#fff;font-size:18px;font-weight:700">${title}</div>
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
  const now = new Date();
  const prefix = 'DS-' + now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0');

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
    const rlsTables = ['users', 'projects', 'schedule_candidates', 'blocked_dates', 'settings', 'case_id_counters', 'project_messages'];
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
app.use(express.json());

const CLIENT_BUILD = path.join(__dirname, '../client/dist');
if (fs.existsSync(CLIENT_BUILD)) app.use(express.static(CLIENT_BUILD));

// ── Auth ──────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'ログインIDとパスワードを入力してください' });
  const { rows } = await pool.query(
    'SELECT id,name,display_name,login_id,role,area,password FROM users WHERE login_id=$1', [name]
  );
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });

  const match = await bcrypt.compare(password, u.password).catch(() => false);
  if (!match) return res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });

  const displayName = u.display_name || u.name || u.login_id || 'ユーザー';
  res.json({ id: u.id, name: displayName, login_id: u.login_id, role: u.role, area: u.area || '東京' });
});

// ── ユーザー共通ヘルパー ──────────────────────────────────────
async function upsertUser(id, { display_name, login_id, password, email, area, role }) {
  const hashedPassword = password ? await bcrypt.hash(password, 10) : null;
  await pool.query(
    `UPDATE users SET
      display_name=COALESCE($1,display_name), name=COALESCE($1,name),
      login_id=COALESCE($2,login_id), password=COALESCE($3,password),
      email=COALESCE($4,email), area=COALESCE($5,area)
     WHERE id=$6`,
    [display_name || null, login_id || null, hashedPassword, email !== undefined ? email : null, area || null, id]
  );
}

// ── 営業 CRUD ─────────────────────────────────────────────────
app.get('/api/users', async (_req, res) => {
  const { rows } = await pool.query("SELECT id,display_name,login_id,email,area FROM users WHERE role='sales' ORDER BY display_name");
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
  if (rows[0].role === 'admin') return res.status(403).json({ error: '管理者はこのAPIから変更できません' });
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
  if (rows[0].role === 'admin') return res.status(403).json({ error: '管理者はこのAPIから削除できません' });
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ── 管理者 CRUD ───────────────────────────────────────────────
app.get('/api/admins', async (_req, res) => {
  const { rows } = await pool.query("SELECT id,display_name,login_id,email,area FROM users WHERE role='admin' ORDER BY display_name");
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
  const { rows } = await pool.query("SELECT id,display_name,login_id,email,area FROM users WHERE role='cs' ORDER BY area, display_name");
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
function parseProject(p) {
  return { ...p, cs_members: JSON.parse(p.cs_members || '[]') };
}

// ── Projects ──────────────────────────────────────────────────
app.get('/api/projects', async (_req, res) => {
  const { rows: projects } = await pool.query('SELECT * FROM projects ORDER BY updated_at DESC');
  const { rows: candidates } = await pool.query('SELECT * FROM schedule_candidates ORDER BY candidate_date');
  const candMap = {};
  candidates.forEach(c => { if (!candMap[c.project_id]) candMap[c.project_id] = []; candMap[c.project_id].push(c); });
  res.json(projects.map(p => ({ ...parseProject(p), candidates: (candMap[p.id] || []).map(c => ({ ...c, cs_members: JSON.parse(c.cs_members || '[]') })) })));
});
app.get('/api/projects/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const { rows: candidates } = await pool.query('SELECT * FROM schedule_candidates WHERE project_id=$1 ORDER BY candidate_date', [req.params.id]);
  res.json({ ...parseProject(rows[0]), candidates: candidates.map(c => ({ ...c, cs_members: JSON.parse(c.cs_members || '[]') })) });
});

// 新規登録
app.post('/api/projects', async (req, res) => {
  const { client_name, project_type, sales_rep, memo, delivery_method, candidate_days, client_url } = req.body;
  if (!client_name?.trim() || !project_type?.trim() || !sales_rep?.trim() || !memo?.trim()) {
    console.error('[POST /projects] 必須項目不足:', { client_name, project_type, sales_rep, memo });
    return res.status(400).json({ error: '必須項目が不足しています（備考は必須です）' });
  }
  if (memo && memo.length > 50) return res.status(400).json({ error: '備考は50文字以内で入力してください' });
  if (client_url && client_url.trim() && !/^https?:\/\//i.test(client_url.trim())) {
    return res.status(400).json({ error: '顧客情報URLは http:// または https:// から始めてください' });
  }
  const id = uuidv4();
  const case_id = await generateCaseId();
  await pool.query(
    `INSERT INTO projects (id,case_id,client_name,project_type,sales_rep,memo,client_url,delivery_method,candidate_days,status,cs_members) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending','[]')`,
    [id, case_id, client_name, project_type, sales_rep, memo || '', (client_url || '').trim(), delivery_method || 'remote', candidate_days || 1]
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
  const { client_name, project_type, sales_rep, memo, client_url, delivery_method, candidate_days, cs_members, candidates, status, confirmed_date } = req.body;
  if (memo && memo.length > 50) return res.status(400).json({ error: '備考は50文字以内で入力してください' });
  if (client_url && client_url.trim() && !/^https?:\/\//i.test(client_url.trim())) {
    return res.status(400).json({ error: '顧客情報URLは http:// または https:// から始めてください' });
  }
  const { rows: ex } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!ex[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = ex[0];
  const csMembersJson = cs_members !== undefined ? JSON.stringify(cs_members) : p.cs_members;
  await pool.query(
    `UPDATE projects SET client_name=$1,project_type=$2,sales_rep=$3,memo=$4,status=$5,confirmed_date=$6,delivery_method=$7,candidate_days=$8,cs_members=$9,client_url=$10,updated_at=NOW() WHERE id=$11`,
    [client_name??p.client_name, project_type??p.project_type, sales_rep??p.sales_rep, memo??p.memo,
     status??p.status, confirmed_date??p.confirmed_date, delivery_method??p.delivery_method, candidate_days??p.candidate_days, csMembersJson,
     client_url !== undefined ? client_url.trim() : p.client_url, req.params.id]
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

  await pool.query("UPDATE projects SET status='scheduled', updated_at=NOW() WHERE id=$1", [req.params.id]);

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
  const fullDate = confirmed_time ? `${confirmed_date} ${confirmed_time}` : confirmed_date;
  const csMembersArr = cs_members || p.cs_members || [];
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
  const { requester_login_id } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(rows[0]);
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
  const { rows } = await pool.query(
    'SELECT * FROM project_messages WHERE project_id=$1 ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json(rows);
});

app.post('/api/projects/:id/messages', async (req, res) => {
  const { body, sender_name, sender_role, sender_login_id } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'メッセージを入力してください' });
  if (!sender_name?.trim()) return res.status(400).json({ error: '送信者情報が取得できませんでした' });
  const { rows: proj } = await pool.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
  if (!proj[0]) return res.status(404).json({ error: '案件が見つかりません' });
  const p = parseProject(proj[0]);

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
      const salesEmail = await getSalesEmail(p.sales_rep);
      allTo = salesEmail ? [salesEmail] : [];
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
    for (const p_ of projects) {
      const p = parseProject(p_);
      const deadline = addBusinessDays(p.scheduled_at, 10);
      const warningDay = addBusinessDays(p.scheduled_at, 9);
      const todayStr = new Date().toISOString().split('T')[0];
      const deadlineStr = deadline.toISOString().split('T')[0];
      const warningStr = warningDay.toISOString().split('T')[0];
      if (todayStr >= deadlineStr) {
        await pool.query(`UPDATE projects SET status='cancelled', cancel_reason='未確定のため（自動キャンセル）', updated_at=NOW() WHERE id=$1`, [p.id]);
        await pool.query('DELETE FROM schedule_candidates WHERE project_id=$1', [p.id]);
        const allTo = await buildRecipients(p.sales_rep, p.cs_members);
        if (allTo.length) await sendTemplatedEmail('auto_cancelled', allTo, { case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep, detail_url: buildDetailUrl(p.id) });
      } else if (todayStr === warningStr) {
        const allTo = await buildRecipients(p.sales_rep, p.cs_members);
        if (allTo.length) await sendTemplatedEmail('auto_cancel_warning', allTo, { case_id: p.case_id || '', project_type: p.project_type, client_name: p.client_name, sales_rep: p.sales_rep, deadline_date: deadlineStr, detail_url: buildDetailUrl(p.id) });
      }
    }
  } catch (e) { console.error('[AutoCancel error]', e.message); }
}

app.delete('/api/projects/:id', async (req, res) => {
  const { requester_login_id } = req.query;
  // requester が営業の場合、自分の担当案件かチェック
  if (requester_login_id) {
    const { rows: reqUser } = await pool.query('SELECT role, display_name FROM users WHERE login_id=$1', [requester_login_id]);
    const requester = reqUser[0];
    if (requester && requester.role === 'sales') {
      const { rows: proj } = await pool.query('SELECT sales_rep FROM projects WHERE id=$1', [req.params.id]);
      if (proj[0] && proj[0].sales_rep !== requester.display_name) {
        return res.status(403).json({ error: '自分が担当する案件のみ削除できます' });
      }
    }
  }
  await pool.query('DELETE FROM projects WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// 選択削除：複数の案件IDを指定して一括削除
app.post('/api/projects/bulk-delete', async (req, res) => {
  const { ids, requester_login_id } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '削除する案件が選択されていません' });
  }

  // requester が営業の場合、自分の担当案件IDのみに絞り込む（他人の案件IDが混じっていても無視）
  let targetIds = ids;
  if (requester_login_id) {
    const { rows: reqUser } = await pool.query('SELECT role, display_name FROM users WHERE login_id=$1', [requester_login_id]);
    const requester = reqUser[0];
    if (requester && requester.role === 'sales') {
      const { rows: ownedProjects } = await pool.query(
        'SELECT id FROM projects WHERE id = ANY($1) AND sales_rep=$2',
        [ids, requester.display_name]
      );
      targetIds = ownedProjects.map(p => p.id);
      if (targetIds.length === 0) {
        return res.status(403).json({ error: '削除できる案件がありません（自分が担当する案件のみ削除できます）' });
      }
    }
  }

  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = ANY($1)', [targetIds]);
  res.json({ success: true, deleted: rowCount });
});

// 一括削除：指定ステータスの案件を全件削除（確定済み／キャンセルのみ許可）
app.post('/api/projects/delete-by-status', async (req, res) => {
  const { status, requester_login_id } = req.body;
  const allowedStatuses = ['confirmed', 'cancelled'];
  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({ error: 'このステータスの一括削除はできません' });
  }

  // requester が営業の場合、自分の担当案件のみ削除（他営業の案件は対象外）
  if (requester_login_id) {
    const { rows: reqUser } = await pool.query('SELECT role, display_name FROM users WHERE login_id=$1', [requester_login_id]);
    const requester = reqUser[0];
    if (requester && requester.role === 'sales') {
      const { rowCount } = await pool.query(
        'DELETE FROM projects WHERE status=$1 AND sales_rep=$2',
        [status, requester.display_name]
      );
      return res.json({ success: true, deleted: rowCount });
    }
  }

  const { rowCount } = await pool.query('DELETE FROM projects WHERE status=$1', [status]);
  res.json({ success: true, deleted: rowCount });
});

app.get('/api/stats', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE TRUE) AS total,
           COUNT(*) FILTER (WHERE status='pending') AS pending,
           COUNT(*) FILTER (WHERE status='scheduled') AS scheduled,
           COUNT(*) FILTER (WHERE status='confirmed') AS confirmed,
           COUNT(*) FILTER (WHERE status='delivered') AS delivered
    FROM projects
  `);
  const r = rows[0];
  res.json({ total: +r.total, pending: +r.pending, scheduled: +r.scheduled, confirmed: +r.confirmed, delivered: +r.delivered });
});

app.get('*', (_req, res) => {
  if (fs.existsSync(CLIENT_BUILD)) res.sendFile(path.join(CLIENT_BUILD, 'index.html'));
  else res.json({ message: 'API running' });
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
  setInterval(runAutoCancel, 60 * 60 * 1000);
  runAutoCancel();
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
