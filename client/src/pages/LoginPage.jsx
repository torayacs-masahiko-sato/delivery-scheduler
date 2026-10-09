import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import MfaSetup from '../components/MfaSetup';

const errBox = { color: 'var(--danger)', fontSize: '0.82rem', marginBottom: 12, padding: '8px 12px', background: 'rgba(239,68,68,0.08)', borderRadius: 8 };

export default function LoginPage() {
  const { login } = useAuth();
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // 画面の段階: password(ID・パスワード) → code(認証コード) / setup(管理者の初回設定)
  const [stage, setStage] = useState('password');
  const [mfaToken, setMfaToken] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [code, setCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);

  const backToStart = (msg = '') => {
    setStage('password'); setPassword(''); setCode(''); setMfaToken(''); setSetupToken(''); setUseBackup(false); setError(msg);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.login(loginId, password);
      if (res.mfa_required) { setMfaToken(res.mfa_token); setStage('code'); }
      else if (res.mfa_setup_required) { setSetupToken(res.setup_token); setStage('setup'); }
      else login(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      login(await api.mfaVerify(mfaToken, code.trim()));
    } catch (err) {
      // 猶予時間切れ（5分）は最初からやり直し。コード間違いはその場で再入力
      if (/最初からログイン/.test(err.message)) backToStart(err.message);
      else { setError(err.message); setCode(''); }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '2.4rem', marginBottom: 10 }}>{stage === 'password' ? '📦' : '🔐'}</div>
          <div className="login-title">{stage === 'setup' ? '多要素認証の設定' : stage === 'code' ? '認証コードの入力' : '納品スケジューラー'}</div>
          <div className="login-sub">
            {stage === 'password' && 'ログインIDとパスワードを入力してください'}
            {stage === 'code' && (useBackup ? 'バックアップコードを入力してください' : '認証アプリに表示されている6桁の数字を入力してください')}
            {stage === 'setup' && '管理者アカウントは、認証アプリによる追加の本人確認が必須です'}
          </div>
        </div>

        {stage === 'password' && (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>ログインID</label>
              <input value={loginId} onChange={e => setLoginId(e.target.value)} placeholder="ログインIDを入力"
                required autoComplete="username" autoCapitalize="off" />
            </div>
            <div className="form-group">
              <label>パスワード</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="パスワードを入力"
                required autoComplete="current-password" />
            </div>
            {error && <div style={errBox}>{error}</div>}
            <button className="btn btn-primary btn-full" type="submit" disabled={loading}>
              {loading ? 'ログイン中...' : 'ログイン'}
            </button>
          </form>
        )}

        {stage === 'code' && (
          <form onSubmit={handleVerify}>
            <div className="form-group">
              <input
                inputMode={useBackup ? 'text' : 'numeric'} autoComplete="one-time-code" autoFocus required
                placeholder={useBackup ? 'XXXXX-XXXXX' : '000000'}
                value={code}
                onChange={e => setCode(useBackup ? e.target.value : e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                style={{ textAlign: 'center', fontSize: '1.4rem', letterSpacing: useBackup ? '0.1em' : '0.35em', fontFamily: 'monospace' }}
              />
            </div>
            {error && <div style={errBox}>{error}</div>}
            <button className="btn btn-primary btn-full" type="submit" disabled={loading || (!useBackup && code.length !== 6) || (useBackup && code.trim().length < 10)}>
              {loading ? '確認中...' : 'ログイン'}
            </button>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: '0.8rem' }}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setUseBackup(b => !b); setCode(''); setError(''); }}>
                {useBackup ? '認証アプリのコードを使う' : 'バックアップコードを使う'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => backToStart()}>← 戻る</button>
            </div>
          </form>
        )}

        {stage === 'setup' && (
          <MfaSetup setupToken={setupToken} onDone={(u) => login(u)} onCancel={() => backToStart()} />
        )}
      </div>
    </div>
  );
}
