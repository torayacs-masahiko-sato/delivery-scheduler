import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { ThemeProvider, useTheme } from './hooks/useTheme';
import { useToast, ToastContainer } from './hooks/useToast';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import NewProjectPage from './pages/NewProjectPage';
import DetailPage from './pages/DetailPage';
import CalendarPage from './pages/CalendarPage';
import AdminUsersPage from './pages/AdminUsersPage';
import SecurityModal from './components/SecurityModal';

const IconHome     = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z"/><path d="M9 21V12h6v9"/></svg>;
const IconPlus     = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>;
const IconCalendar = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>;
const IconUsers    = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/><path d="M16 3.13a4 4 0 010 7.75"/><path d="M21 21v-2a4 4 0 00-3-3.87"/></svg>;
const IconSun      = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>;
const IconMoon     = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>;

// ── ライト／ダークモード切り替えボタン ─────────────────────
function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isLight = theme === 'light';
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={toggleTheme}
      aria-label={isLight ? 'ダークモードに切り替え' : 'ライトモードに切り替え'}
      title={isLight ? 'ダークモードに切り替え' : 'ライトモードに切り替え'}
      style={{ padding: '4px 8px', display: 'flex', alignItems: 'center' }}
    >
      {isLight ? <IconMoon /> : <IconSun />}
    </button>
  );
}

// ── スプラッシュ（起動準備中）────────────────────────────────
function SplashScreen() {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const t = setInterval(() => setDots(d => d.length >= 3 ? '' : d + '.'), 600);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 24,
      background: 'var(--navy, #0f1623)',
    }}>
      <div style={{ fontSize: '3rem' }}>📦</div>
      <div style={{ fontWeight: 700, fontSize: '1.25rem', color: '#fff', letterSpacing: '0.02em' }}>
        納品スケジューラー
      </div>
      {/* スピナー */}
      <div style={{
        width: 36, height: 36, borderRadius: '50%',
        border: '3px solid rgba(59,130,246,0.2)',
        borderTopColor: '#3b82f6',
        animation: 'spin 0.9s linear infinite',
      }} />
      <div style={{ fontSize: '0.88rem', color: 'rgba(255,255,255,0.5)' }}>
        🚀 起動準備中{dots}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── サーバー疎通確認 ─────────────────────────────────────────
async function pingServer(retries = 60, intervalMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch { /* サーバー未起動 */ }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function AppInner() {
  const { user, logout } = useAuth();
  const { toasts, addToast } = useToast();
  const [page, setPage] = useState('dashboard');
  const [detailId, setDetailId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSecurity, setShowSecurity] = useState(false);
  const [serverReady, setServerReady] = useState(null); // null=確認中, true=OK, false=失敗

  // 起動時にサーバーが応答するまでスプラッシュを表示
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // まず即時試行、応答があればすぐ表示
      try {
        const res = await fetch('/api/health', { signal: AbortSignal.timeout(2000) });
        if (!cancelled && res.ok) { setServerReady(true); return; }
      } catch { /* スリープ中 */ }
      // スリープ中 → スプラッシュを出してリトライ
      if (!cancelled) setServerReady(false);
      const ok = await pingServer();
      if (!cancelled) setServerReady(ok ? true : false);
    })();
    return () => { cancelled = true; };
  }, []);

  // メール内リンク（?p=案件ID）を検知し、ログイン後に自動でその案件を開けるよう保存
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pendingId = params.get('p');
    if (pendingId) {
      sessionStorage.setItem('ds_pending_detail', pendingId);
      // URLをきれいにする（再読み込み時に誤って再検知しないように）
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // ログイン済みになったタイミングで、保留中の案件詳細へ自動遷移
  useEffect(() => {
    if (!user) return;
    const pendingId = sessionStorage.getItem('ds_pending_detail');
    if (pendingId) {
      setPage('detail');
      setDetailId(pendingId);
      sessionStorage.removeItem('ds_pending_detail');
    }
  }, [user]);

  // 初回確認中（null）はごく短時間なので空表示
  if (serverReady === null) return null;
  // サーバー未応答 → スプラッシュ継続
  if (serverReady === false) return <SplashScreen />;

  if (!user) return <LoginPage />;

  const navigate = (to, id) => { setPage(to); if (id) setDetailId(id); };
  const refresh = () => setRefreshKey(k => k + 1);

  const NAV_SALES = [
    { key: 'dashboard', label: 'ホーム',     Icon: IconHome },
    { key: 'new',       label: '案件登録',   Icon: IconPlus },
    { key: 'calendar',  label: 'カレンダー', Icon: IconCalendar },
  ];
  const NAV_ADMIN = [
    { key: 'dashboard', label: 'ホーム',     Icon: IconHome },
    { key: 'new',       label: '案件登録',   Icon: IconPlus },
    { key: 'calendar',  label: 'カレンダー', Icon: IconCalendar },
    { key: 'users',     label: 'メンバー',   Icon: IconUsers },
  ];
  const NAV = user.role === 'admin' ? NAV_ADMIN : NAV_SALES;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-logo"><span className="dot" />納品スケジューラー</div>
        <div className="topbar-right">
          <ThemeToggle />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSecurity(true)} aria-label="セキュリティ設定" title="セキュリティ設定（多要素認証）" style={{ padding: '4px 8px' }}>🔐</button>
          <span className="topbar-user" style={{ fontSize: '0.82rem' }}>{user.name}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => { logout(); setPage('dashboard'); }} style={{ padding: '4px 10px', whiteSpace: 'nowrap' }}>
            ログアウト
          </button>
        </div>
      </header>

      <main className="main-content" key={page === 'detail' ? detailId : page + refreshKey}>
        {page === 'dashboard' && <DashboardPage onNavigate={navigate} key={refreshKey} />}
        {page === 'new' && <NewProjectPage addToast={addToast} onSaved={() => { refresh(); setPage('dashboard'); }} />}
        {page === 'calendar' && <CalendarPage onNavigate={navigate} key={refreshKey} />}
        {page === 'detail' && detailId && (
          <DetailPage projectId={detailId} onBack={() => setPage('dashboard')} addToast={addToast} onRefresh={refresh} />
        )}
        {page === 'users' && user.role === 'admin' && <AdminUsersPage addToast={addToast} />}
      </main>

      <nav className="bottom-nav">
        {NAV.map(({ key, label, Icon }) => (
          <button key={key}
            className={`nav-item ${page === key || (page === 'detail' && key === 'dashboard') ? 'active' : ''}`}
            onClick={() => setPage(key)}>
            <Icon />{label}
          </button>
        ))}
      </nav>

      {showSecurity && <SecurityModal onClose={() => setShowSecurity(false)} addToast={addToast} />}
      <ToastContainer toasts={toasts} />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider><AppInner /></AuthProvider>
    </ThemeProvider>
  );
}
