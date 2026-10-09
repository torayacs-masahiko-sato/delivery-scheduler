import { useState, useEffect } from 'react';
import { api } from '../api';

const errBox = { color: 'var(--danger)', fontSize: '0.82rem', marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8 };
const codeInputStyle = { textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.35em', fontFamily: 'monospace' };

/**
 * 認証アプリの初回設定（QR表示 → 6桁コードで確認 → バックアップコード表示）
 * setupToken: ログイン画面からの初回設定時に渡す（ログイン済みの場合は不要）
 * onDone(user): 設定完了＆バックアップコードを保存済みにしたとき呼ぶ
 */
export default function MfaSetup({ setupToken, onDone, onCancel }) {
  const [qr, setQr] = useState(null);
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // { backup_codes, user }
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.mfaSetupStart(setupToken)
      .then(d => { if (!cancelled) { setQr(d.qr); setSecret(d.secret); } })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [setupToken]);

  const confirm = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try { setResult(await api.mfaSetupConfirm(setupToken, code.replace(/\s/g, ''))); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  };

  const copyCodes = async () => {
    try { await navigator.clipboard.writeText(result.backup_codes.join('\n')); alert('コピーしました'); }
    catch { alert('コピーできませんでした。手書きまたはスクリーンショットで保管してください'); }
  };

  // ── 手順2: バックアップコード ──
  if (result) {
    return (
      <div>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>✅ 設定が完了しました</div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', lineHeight: 1.7, marginBottom: 12 }}>
          下の<b>バックアップコード</b>は、スマホを紛失・機種変更したときの予備のログイン用です（各コード1回だけ使えます）。
          <b>この画面を閉じると二度と表示されません。</b>安全な場所に保管してください。
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 12, borderRadius: 10, background: 'var(--card-bg)', border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: '0.95rem', marginBottom: 10, textAlign: 'center' }}>
          {result.backup_codes.map(c => <div key={c}>{c}</div>)}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copyCodes} style={{ marginBottom: 12 }}>📋 コピー</button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.84rem', marginBottom: 14, cursor: 'pointer' }}>
          <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
          バックアップコードを保管しました
        </label>
        <button className="btn btn-primary btn-full" disabled={!saved} onClick={() => onDone(result.user)}>完了</button>
      </div>
    );
  }

  // ── 手順1: QR → コード確認 ──
  return (
    <form onSubmit={confirm}>
      <ol style={{ fontSize: '0.8rem', color: 'var(--text-sub)', lineHeight: 1.8, paddingLeft: 18, margin: '0 0 12px' }}>
        <li>スマホに認証アプリ（Google Authenticator / Microsoft Authenticator など）を入れる</li>
        <li>アプリで「＋」→「QRコードをスキャン」で下のQRを読み取る</li>
        <li>アプリに表示された6桁の数字を入力して「設定する」</li>
      </ol>
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        {qr ? <img src={qr} alt="認証アプリ用QRコード" width={200} height={200} style={{ background: '#fff', padding: 6, borderRadius: 8 }} />
            : !error && <div style={{ padding: 40, fontSize: '0.85rem', color: 'var(--text-sub)' }}>QRコードを準備中...</div>}
      </div>
      {secret && (
        <details style={{ fontSize: '0.75rem', color: 'var(--text-sub)', marginBottom: 12 }}>
          <summary style={{ cursor: 'pointer' }}>QRが読み取れない場合（手入力用キー）</summary>
          <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', marginTop: 6, userSelect: 'all' }}>{secret}</div>
        </details>
      )}
      <div className="form-group">
        <label>6桁の認証コード</label>
        <input inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="000000"
          value={code} onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} style={codeInputStyle} required />
      </div>
      {error && <div style={errBox}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        {onCancel && <button type="button" className="btn btn-ghost" style={{ flex: 1, whiteSpace: 'nowrap' }} onClick={onCancel}>キャンセル</button>}
        <button className="btn btn-primary" style={{ flex: 2 }} type="submit" disabled={loading || !qr || code.length !== 6}>
          {loading ? '確認中...' : '設定する'}
        </button>
      </div>
    </form>
  );
}
