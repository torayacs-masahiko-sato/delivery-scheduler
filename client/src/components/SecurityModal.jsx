import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import MfaSetup from './MfaSetup';

const errBox = { color: 'var(--danger)', fontSize: '0.82rem', marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8 };

/** ヘッダーの🔐から開く「セキュリティ設定」。管理者は必須（解除不可）、営業・CS部員は任意で設定できる */
export default function SecurityModal({ onClose, addToast }) {
  const { user, updateUser } = useAuth();
  const [status, setStatus] = useState(null);
  const [mode, setMode] = useState('home'); // home | setup | disable | codes
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [newCodes, setNewCodes] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => api.mfaStatus().then(setStatus).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const go = (m) => { setMode(m); setError(''); setPw(''); setCode(''); setNewCodes(null); };

  const run = async (fn) => {
    setError(''); setLoading(true);
    try { await fn(); } catch (e) { setError(e.message); } finally { setLoading(false); }
  };

  const doDisable = (e) => { e.preventDefault(); run(async () => {
    await api.mfaDisable(pw, code.trim());
    updateUser({ mfa_enabled: false }); addToast('多要素認証を解除しました'); await load(); go('home');
  }); };
  const doNewCodes = (e) => { e.preventDefault(); run(async () => {
    const r = await api.mfaNewBackupCodes(code.trim()); setNewCodes(r.backup_codes); await load();
  }); };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflowY: 'auto' }}>
      <div style={{ background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--glass-border)', borderRadius: 20, padding: 24, width: '100%', maxWidth: 400, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>🔐 セキュリティ設定</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>閉じる</button>
        </div>

        {!status && !error && <div style={{ fontSize: '0.85rem', color: 'var(--text-sub)' }}>読み込み中...</div>}
        {error && mode === 'home' && <div style={errBox}>{error}</div>}

        {status && mode === 'home' && (
          <>
            <div className="card" style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>多要素認証（認証アプリ）</div>
              <div style={{ fontSize: '0.85rem' }}>
                状態: {status.enabled ? <b style={{ color: 'var(--success, #22c55e)' }}>有効</b> : <b>未設定</b>}
                {status.required && <span style={{ color: 'var(--text-sub)' }}>（管理者は必須）</span>}
              </div>
              {status.enabled && <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)', marginTop: 4 }}>残りバックアップコード: {status.backup_remaining} 個</div>}
            </div>
            {!status.enabled && <button className="btn btn-primary btn-full" onClick={() => go('setup')}>認証アプリを設定する</button>}
            {status.enabled && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button className="btn btn-ghost btn-full" onClick={() => go('codes')}>バックアップコードを再発行する</button>
                {!status.required && <button className="btn btn-danger btn-full" onClick={() => go('disable')}>多要素認証を解除する</button>}
              </div>
            )}
            {status.enabled && status.required && (
              <div style={{ fontSize: '0.74rem', color: 'var(--text-sub)', marginTop: 10, lineHeight: 1.6 }}>
                スマホの紛失・機種変更の際は、バックアップコードでログインするか、他の管理者に「リセット」を依頼してください。
              </div>
            )}
          </>
        )}

        {mode === 'setup' && (
          <MfaSetup onCancel={() => go('home')} onDone={async (u) => { updateUser({ mfa_enabled: true }); addToast('多要素認証を有効にしました'); await load(); go('home'); }} />
        )}

        {mode === 'disable' && (
          <form onSubmit={doDisable}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: 12 }}>解除するには、パスワードと認証コードの両方が必要です。</div>
            <div className="form-group"><label>パスワード</label>
              <input type="password" value={pw} onChange={e => setPw(e.target.value)} required autoComplete="current-password" /></div>
            <div className="form-group"><label>認証コード（6桁 または バックアップコード）</label>
              <input value={code} onChange={e => setCode(e.target.value)} required autoComplete="one-time-code" style={{ fontFamily: 'monospace' }} /></div>
            {error && <div style={errBox}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={() => go('home')}>キャンセル</button>
              <button className="btn btn-danger" style={{ flex: 1 }} type="submit" disabled={loading}>{loading ? '処理中...' : '解除する'}</button>
            </div>
          </form>
        )}

        {mode === 'codes' && !newCodes && (
          <form onSubmit={doNewCodes}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: 12 }}>
              新しいバックアップコードを発行します。<b>古いコードは使えなくなります。</b>認証アプリに表示されている6桁を入力してください。
            </div>
            <div className="form-group"><input inputMode="numeric" maxLength={6} placeholder="000000" value={code}
              onChange={e => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} required autoComplete="one-time-code"
              style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: '0.35em', fontFamily: 'monospace' }} /></div>
            {error && <div style={errBox}>{error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={() => go('home')}>キャンセル</button>
              <button className="btn btn-primary" style={{ flex: 1 }} type="submit" disabled={loading || code.length !== 6}>{loading ? '処理中...' : '再発行'}</button>
            </div>
          </form>
        )}
        {mode === 'codes' && newCodes && (
          <>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: 10 }}>この画面を閉じると再表示できません。安全な場所に保管してください。</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 12, borderRadius: 10, background: 'var(--card-bg)', border: '1px solid var(--border)', fontFamily: 'monospace', textAlign: 'center', marginBottom: 12 }}>
              {newCodes.map(c => <div key={c}>{c}</div>)}
            </div>
            <button className="btn btn-primary btn-full" onClick={() => go('home')}>保管したので閉じる</button>
          </>
        )}
      </div>
    </div>
  );
}
