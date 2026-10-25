import { useState, useEffect } from 'react';
import { api } from '../api';
import { passkeySupported, registerPasskey, guessDeviceName } from '../passkey';

const fmt = (s) => s ? new Date(s).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未使用';

/** セキュリティ設定内：自分のパスキー（生体認証・端末PIN）の登録・一覧・削除 */
export default function PasskeySection({ addToast }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const supported = passkeySupported();

  const load = () => api.passkeyList().then(setList).catch(e => setError(e.message));
  useEffect(() => { load(); }, []);

  const handleRegister = async () => {
    const name = window.prompt('この端末の名前（一覧で見分けるために使います）', guessDeviceName());
    if (name === null) return; // キャンセル
    setError(''); setBusy(true);
    try { await registerPasskey(name); addToast('この端末を登録しました'); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const handleDelete = async (pk) => {
    if (!confirm(`「${pk.device_name}」の登録を削除しますか？\n削除した端末では生体認証でログインできなくなります。`)) return;
    try { await api.passkeyDelete(pk.id); addToast('登録を削除しました'); await load(); }
    catch (e) { addToast(e.message, 'error'); }
  };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>🔑 生体認証・パスキー</div>
      <div style={{ fontSize: '0.76rem', color: 'var(--text-sub)', lineHeight: 1.6, marginBottom: 10 }}>
        端末を登録すると、次回から顔認証・指紋・端末のPINだけでログインできます（6桁コードも不要）。顔や指紋の情報は端末の外に出ません。
      </div>
      {list && list.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {list.map(pk => (
            <div key={pk.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pk.device_name}</div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-sub)' }}>最終利用：{fmt(pk.last_used_at)}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleDelete(pk)}>削除</button>
            </div>
          ))}
        </div>
      )}
      {list && list.length === 0 && <div style={{ fontSize: '0.8rem', marginBottom: 10 }}>登録済みの端末はありません</div>}
      {error && <div style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: 8 }}>{error}</div>}
      {supported
        ? <button type="button" className="btn btn-primary btn-full" onClick={handleRegister} disabled={busy}>{busy ? '端末の認証を待っています...' : '＋ この端末を登録する'}</button>
        : <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)' }}>このブラウザはパスキーに対応していません</div>}
    </div>
  );
}
