import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import StaffPicker from '../components/StaffPicker';

const DELIVERY_LABELS = { remote: '🖥 リモート', onsite: '🚗 現地訪問' };
const PROJECT_TYPES = ['新規納品', '増設納品', 'PC入替え', 'I/O機器納品', '打合せ', '調査'];

export default function NewProjectPage({ onSaved, addToast }) {
  const { user } = useAuth();
  const [form, setForm] = useState({
    client_name: '',
    project_type: [],
    sales_rep: user.role === 'sales' ? user.name : '',
    memo: '',
    client_url: '',
    delivery_method: 'remote',
    candidate_days: 1,
  });
  const [salesUsers, setSalesUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  // 画面の段階: input(入力) → confirm(確認)。入力内容はformに残るので「修正する」で戻っても消えない
  const [step, setStep] = useState('input');
  const [showSalesPicker, setShowSalesPicker] = useState(false);

  useEffect(() => { api.getUsers().then(setSalesUsers); }, []);

  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const toggleProjectType = (type) => {
    setForm(f => {
      const has = f.project_type.includes(type);
      // PROJECT_TYPES の並び順を維持したまま追加・削除する
      const next = has
        ? f.project_type.filter(t => t !== type)
        : PROJECT_TYPES.filter(t => f.project_type.includes(t) || t === type);
      return { ...f, project_type: next };
    });
  };

  const handleMemo = (v) => {
    if (v.length <= 50) setField('memo', v);
  };

  // 登録に使う担当営業名（営業ロールの場合は user.name を確実にセット＝空文字対策）
  const resolveSalesRep = () =>
    (user.role === 'sales' || user.role === 'cs') ? user.name : form.sales_rep;

  // 入力チェック。問題なければ true を返す（確認画面へ進む前・登録直前の両方で使う）
  const validate = () => {
    if (!form.project_type.length) { addToast('案件内容を1つ以上選択してください', 'error'); return false; }
    if (!form.client_name?.trim()) { addToast('顧客名を入力してください', 'error'); return false; }
    if (form.client_url?.trim() && !/^https?:\/\//i.test(form.client_url.trim())) {
      addToast('顧客情報URLは http:// または https:// から入力してください', 'error'); return false;
    }
    if (!form.memo?.trim()) { addToast('備考を入力してください', 'error'); return false; }
    if (!resolveSalesRep()?.trim()) { addToast('担当営業を選択してください', 'error'); return false; }
    return true;
  };

  // 入力画面の「確認画面へ」→ 入力チェック後、確認画面を表示する（この時点ではまだ登録しない）
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    setStep('confirm');
    window.scrollTo({ top: 0 });
  };

  // 確認画面の「修正する」→ 入力内容(form)はそのまま保持して入力画面へ戻る
  const handleBack = () => {
    setStep('input');
    window.scrollTo({ top: 0 });
  };

  // 確認画面の「この内容で登録する」→ ここで初めてサーバーへ登録する
  const handleRegister = async () => {
    if (loading) return; // 二重登録防止
    if (!validate()) { setStep('input'); return; }
    setLoading(true);
    try {
      // 複数選択された案件内容は「・」区切りの1つの文字列として保存する
      const project_type = form.project_type.join('・');
      await api.createProject({ ...form, project_type, sales_rep: resolveSalesRep(), candidates: [] });
      addToast('案件を登録しました');
      onSaved();
    } catch (err) {
      // 失敗時は確認画面に留まり、「修正する」または再度の登録ができる
      addToast(err.message, 'error');
    } finally { setLoading(false); }
  };

  const memoLen = form.memo.length;

  // ── 確認画面 ───────────────────────────────────────────
  if (step === 'confirm') {
    const rows = [
      { label: '顧客名', value: form.client_name.trim() },
      {
        label: '顧客情報URL',
        value: form.client_url.trim()
          ? <span style={{ wordBreak: 'break-all', color: 'var(--accent-lt)' }}>{form.client_url.trim()}</span>
          : <span style={{ color: 'var(--text-sub)' }}>未入力</span>,
      },
      { label: '案件内容', value: form.project_type.join('・') },
      { label: '担当営業', value: resolveSalesRep() },
      { label: '納品方法', value: DELIVERY_LABELS[form.delivery_method] },
      { label: '備考', value: form.memo.trim() },
      { label: '希望候補日数', value: `${form.candidate_days}日` },
    ];
    return (
      <>
        <div className="page-title">登録内容の確認</div>
        <div className="page-sub">内容に間違いがなければ「この内容で登録する」を押してください</div>

        <div className="card">
          {rows.map((r, i) => (
            <div key={r.label} style={{
              padding: '12px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', marginBottom: 4 }}>{r.label}</div>
              <div style={{ fontSize: '0.95rem', lineHeight: 1.6, wordBreak: 'break-word' }}>{r.value}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)', lineHeight: 1.6, marginBottom: 14 }}>
          ※ 登録すると管理者に通知メールが送信されます
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn btn-ghost" style={{ flex: 1 }}
            onClick={handleBack} disabled={loading}>
            ← 修正する
          </button>
          <button type="button" className="btn btn-primary" style={{ flex: 2 }}
            onClick={handleRegister} disabled={loading}>
            {loading ? '登録中...' : 'この内容で登録する'}
          </button>
        </div>
      </>
    );
  }

  // ── 入力画面 ───────────────────────────────────────────
  return (
    <>
      <div className="page-title">案件を登録</div>
      <div className="page-sub">内容を入力して希望日数を選択してください</div>

      <form onSubmit={handleSubmit}>
        {/* 基本情報 */}
        <div className="card">
          <div className="section-title">基本情報</div>

          <div className="form-group">
            <label>顧客名 *</label>
            <input
              value={form.client_name}
              onChange={e => setField('client_name', e.target.value)}
              placeholder="株式会社〇〇"
              required
            />
          </div>

          <div className="form-group">
            <label>顧客情報URL（任意）</label>
            <input
              type="url"
              value={form.client_url}
              onChange={e => setField('client_url', e.target.value)}
              placeholder="https://example.com/customer/123"
            />
          </div>

          <div className="form-group">
            <label>案件内容 *（複数選択可）</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginTop: 4 }}>
              {PROJECT_TYPES.map(type => {
                const checked = form.project_type.includes(type);
                return (
                  <label key={type} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    cursor: 'pointer', padding: '10px 12px', borderRadius: 8,
                    background: checked ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    transition: 'all 0.15s',
                  }}>
                    <input
                      type="checkbox" name="project_type" value={type}
                      checked={checked}
                      onChange={() => toggleProjectType(type)}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    <span style={{ fontSize: '0.88rem' }}>{type}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {user.role === 'admin' ? (
            <div className="form-group">
              <label>担当営業 *</label>
              <button
                type="button"
                className={`picker-trigger${!form.sales_rep ? ' empty' : ''}`}
                onClick={() => setShowSalesPicker(true)}
              >
                <span className="picker-trigger-chips">
                  {form.sales_rep
                    ? <span className="picker-trigger-chip">{form.sales_rep}</span>
                    : '担当営業を選択してください'}
                </span>
                <span className="picker-trigger-arrow">▼</span>
              </button>
              {showSalesPicker && (
                <StaffPicker
                  title="担当営業を選択"
                  members={salesUsers}
                  value={form.sales_rep ? [form.sales_rep] : []}
                  onChange={(names) => setField('sales_rep', names[0] || '')}
                  onClose={() => setShowSalesPicker(false)}
                  multi={false}
                  addToast={addToast}
                />
              )}
            </div>
          ) : (
            <div className="form-group">
              <label>担当営業</label>
              <input value={user.name} disabled style={{ opacity: 0.6 }} />
            </div>
          )}

          <div className="form-group">
            <label>納品方法 *</label>
            <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
              {[{ value: 'remote', label: '🖥 リモート' }, { value: 'onsite', label: '🚗 現地訪問' }].map(opt => (
                <label key={opt.value} style={{
                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1,
                  background: form.delivery_method === opt.value ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
                  border: `1px solid ${form.delivery_method === opt.value ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 8, padding: '10px 14px', transition: 'all 0.15s',
                }}>
                  <input type="radio" name="delivery_method" value={opt.value}
                    checked={form.delivery_method === opt.value}
                    onChange={() => setField('delivery_method', opt.value)}
                    style={{ width: 'auto', margin: 0 }} />
                  <span style={{ fontSize: '0.9rem' }}>{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label style={{ margin: 0 }}>備考 *</label>
              <span style={{
                fontSize: '0.75rem', fontWeight: 600,
                color: memoLen >= 40 ? (memoLen >= 50 ? 'var(--danger)' : 'var(--warning)') : 'var(--text-sub)',
              }}>
                {memoLen} / 50文字
              </span>
            </div>
            <input
              value={form.memo}
              onChange={e => handleMemo(e.target.value)}
              placeholder="案件の概要を簡潔に記載（50文字以内）"
              maxLength={50}
              required
            />
          </div>
        </div>

        {/* 希望候補日数 */}
        <div className="card">
          <div className="section-title">希望候補日数</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: 14, lineHeight: 1.6 }}>
            管理者がカレンダーを確認し、何日分の候補日を設定してほしいですか？
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {[1, 2, 3].map(n => (
              <label key={n} style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 6, cursor: 'pointer', padding: '18px 8px', borderRadius: 12,
                background: form.candidate_days === n ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
                border: `2px solid ${form.candidate_days === n ? 'var(--accent)' : 'var(--border)'}`,
                transition: 'all 0.15s',
              }}>
                <input type="radio" name="candidate_days" value={n}
                  checked={form.candidate_days === n}
                  onChange={() => setField('candidate_days', n)}
                  style={{ display: 'none' }} />
                <span style={{
                  fontSize: '2.2rem', fontWeight: 700, lineHeight: 1,
                  color: form.candidate_days === n ? 'var(--accent)' : 'var(--text)',
                }}>{n}</span>
                <span style={{ fontSize: '0.82rem', color: 'var(--text-sub)' }}>日</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: '0.75rem', color: 'var(--text-sub)', lineHeight: 1.6 }}>
            ※ 管理者がスケジュールを確認し、候補日を設定します
          </div>
        </div>

        <button
          className="btn btn-primary btn-full"
          type="submit"
          disabled={!form.project_type.length || !form.client_name || !form.memo?.trim()}
        >
          確認画面へ
        </button>
      </form>
    </>
  );
}
