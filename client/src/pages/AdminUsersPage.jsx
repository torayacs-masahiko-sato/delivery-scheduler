import { useState, useEffect } from 'react';
import { api } from '../api';

export default function AdminUsersPage({ addToast }) {
  const [tab, setTab] = useState('users');
  return (
    <>
      <div className="page-title">管理者設定</div>
      <div className="filter-bar" style={{ marginBottom: 20 }}>
        {[
          { key: 'users',     label: '👤 営業メンバー' },
          { key: 'cs',        label: '🛠 CS部員' },
          { key: 'admins',    label: '🔑 管理者' },
          { key: 'blocked',   label: '🚫 予定不可日' },
          { key: 'email',     label: '📧 メール設定' },
          { key: 'templates', label: '✏️ メール文面' },
        ].map(t => (
          <button key={t.key} className={`filter-chip ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'users'     && <UsersTab addToast={addToast} />}
      {tab === 'cs'        && <CsMembersTab addToast={addToast} />}
      {tab === 'admins'    && <AdminsTab addToast={addToast} />}
      {tab === 'blocked'   && <BlockedTab addToast={addToast} />}
      {tab === 'email'     && <EmailTab addToast={addToast} />}
      {tab === 'templates' && <TemplatesTab addToast={addToast} />}
    </>
  );
}

// ── メンバー管理（表示名・ログインID・パスワード・メール）────
function UsersTab({ addToast }) {
  const [users, setUsers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState({ display_name: '', login_id: '', password: '', email: '', area: '東京' });
  const [loading, setLoading] = useState(false);

  const load = () => api.getUsers().then(setUsers);
  useEffect(() => { load(); }, []);

  const openAdd = () => { setEditTarget(null); setForm({ display_name: '', login_id: '', password: '', email: '', area: '東京' }); setShowForm(true); };
  const openEdit = (u) => { setEditTarget(u); setForm({ display_name: u.display_name, login_id: u.login_id, password: '', email: u.email || '', area: u.area || '東京' }); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setEditTarget(null); };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    try {
      if (editTarget) {
        const payload = { display_name: form.display_name, login_id: form.login_id, email: form.email, area: form.area };
        if (form.password) payload.password = form.password;
        await api.updateUser(editTarget.id, payload);
        addToast('更新しました');
      } else {
        await api.createUser(form);
        addToast('追加しました');
      }
      await load(); closeForm();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const handleDelete = async (u) => {
    if (!confirm(`「${u.display_name}」を削除しますか？`)) return;
    try { await api.deleteUser(u.id); addToast('削除しました'); await load(); }
    catch (err) { addToast(err.message, 'error'); }
  };

  return (
    <>
      <button className="btn btn-primary btn-sm" style={{ marginBottom: 16 }} onClick={openAdd}>+ 営業担当を追加</button>

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--glass-border)',
            borderRadius: 20, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 20 }}>
              {editTarget ? '営業担当を編集' : '営業担当を追加'}
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>表示名 *</label>
                <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                  placeholder="山田 太郎" required />
              </div>
              <div className="form-group">
                <label>ログインID *</label>
                <input value={form.login_id} onChange={e => setForm(f => ({ ...f, login_id: e.target.value }))}
                  placeholder="yamada" required
                  style={{ fontFamily: 'monospace' }} />
              </div>
              <div className="form-group">
                <label>{editTarget ? '新しいパスワード（変更する場合のみ）' : 'パスワード *'}</label>
                <input type="password" value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editTarget ? '変更しない場合は空白' : 'パスワードを入力'}
                  required={!editTarget} />
              </div>
              <div className="form-group">
                <label>メールアドレス（日程確定時に通知）</label>
                <input type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="yamada@example.com" />
              </div>
              <div className="form-group">
                <label>エリア *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['東京', '大阪'].map(a => (
                    <label key={a} style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      cursor: 'pointer', padding: '10px 12px', borderRadius: 8,
                      background: form.area === a ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
                      border: `1px solid ${form.area === a ? 'var(--accent)' : 'var(--border)'}`,
                    }}>
                      <input type="radio" name="area" value={a} checked={form.area === a}
                        onChange={() => setForm(f => ({ ...f, area: a }))} style={{ width: 'auto', margin: 0 }} />
                      <span style={{ fontSize: '0.88rem' }}>📍 {a}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={closeForm}>キャンセル</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={loading}>
                  {loading ? '保存中...' : editTarget ? '更新' : '追加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {users.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>営業担当がいません</div>
      ) : users.map(u => (
        <div key={u.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>
            {u.display_name?.slice(-1) || '?'}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600 }}>{u.display_name}</span>
              <span style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99, background: 'rgba(59,130,246,0.15)', color: 'var(--accent-lt)' }}>
                📍 {u.area || '東京'}
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', fontFamily: 'monospace' }}>
              ID: {u.login_id}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {u.email ? `📧 ${u.email}` : '📧 未設定'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(u)}>編集</button>
          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(u)}>削除</button>
        </div>
      ))}
    </>
  );
}

// ── 予定不可日管理 ────────────────────────────────────────────
// ── CS部員管理 ─────────────────────────────────────────────────
function CsMembersTab({ addToast }) {
  const [members, setMembers] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState({ display_name: '', login_id: '', password: '', email: '', area: '東京' });
  const [loading, setLoading] = useState(false);

  const load = () => api.getCsMembers().then(setMembers);
  useEffect(() => { load(); }, []);

  const openAdd = () => { setEditTarget(null); setForm({ display_name: '', login_id: '', password: '', email: '', area: '東京' }); setShowForm(true); };
  const openEdit = (m) => { setEditTarget(m); setForm({ display_name: m.display_name, login_id: m.login_id, password: '', email: m.email || '', area: m.area || '東京' }); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setEditTarget(null); };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    try {
      if (editTarget) {
        const payload = { display_name: form.display_name, login_id: form.login_id, email: form.email, area: form.area };
        if (form.password) payload.password = form.password;
        await api.updateCsMember(editTarget.id, payload);
        addToast('CS部員情報を更新しました');
      } else {
        await api.createCsMember(form);
        addToast('CS部員を追加しました');
      }
      await load(); closeForm();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const handleDelete = async (m) => {
    if (!confirm(`CS部員「${m.display_name}」を削除しますか？`)) return;
    try { await api.deleteCsMember(m.id); addToast('削除しました'); await load(); }
    catch (err) { addToast(err.message, 'error'); }
  };

  return (
    <>
      <div style={{ padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, marginBottom: 16, fontSize: '0.78rem', color: 'var(--text-sub)', lineHeight: 1.6 }}>
        仮スケジュール確定時にCS部員を最大2名選択できます。東西エリア問わず選択可能です。
      </div>

      <button className="btn btn-primary btn-sm" style={{ marginBottom: 16 }} onClick={openAdd}>+ CS部員を追加</button>

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--glass-border)',
            borderRadius: 20, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 20 }}>
              {editTarget ? 'CS部員を編集' : 'CS部員を追加'}
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>表示名 *</label>
                <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                  placeholder="田中 CS一郎" required />
              </div>
              <div className="form-group">
                <label>ログインID *</label>
                <input value={form.login_id} onChange={e => setForm(f => ({ ...f, login_id: e.target.value }))}
                  placeholder="cs_tanaka" required style={{ fontFamily: 'monospace' }} />
              </div>
              <div className="form-group">
                <label>{editTarget ? '新しいパスワード（変更する場合のみ）' : 'パスワード *'}</label>
                <input type="password" value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editTarget ? '変更しない場合は空白' : 'パスワードを入力'}
                  required={!editTarget} />
              </div>
              <div className="form-group">
                <label>メールアドレス（仮スケ確定時に通知）</label>
                <input type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="cs_tanaka@example.com" />
              </div>
              <div className="form-group">
                <label>エリア *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['東京', '大阪'].map(a => (
                    <label key={a} style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      cursor: 'pointer', padding: '10px 12px', borderRadius: 8,
                      background: form.area === a ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
                      border: `1px solid ${form.area === a ? 'var(--accent)' : 'var(--border)'}`,
                    }}>
                      <input type="radio" name="cs_area" value={a} checked={form.area === a}
                        onChange={() => setForm(f => ({ ...f, area: a }))} style={{ width: 'auto', margin: 0 }} />
                      <span style={{ fontSize: '0.88rem' }}>📍 {a}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={closeForm}>キャンセル</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={loading}>
                  {loading ? '保存中...' : editTarget ? '更新' : '追加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {members.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>CS部員が登録されていません</div>
      ) : members.map(m => (
        <div key={m.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--purple, #7C3AED)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0, color: '#fff' }}>
            🛠
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600 }}>{m.display_name}</span>
              <span style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99, background: 'rgba(59,130,246,0.15)', color: 'var(--accent-lt)' }}>
                📍 {m.area || '東京'}
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', fontFamily: 'monospace' }}>ID: {m.login_id}</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.email ? `📧 ${m.email}` : '📧 未設定'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(m)}>編集</button>
          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(m)}>削除</button>
        </div>
      ))}
    </>
  );
}

// ── 管理者管理（複数管理者・エリア設定）────────────────────────
function AdminsTab({ addToast }) {
  const [admins, setAdmins] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [form, setForm] = useState({ display_name: '', login_id: '', password: '', email: '', area: '東京' });
  const [loading, setLoading] = useState(false);

  const load = () => api.getAdmins().then(setAdmins);
  useEffect(() => { load(); }, []);

  const openAdd = () => { setEditTarget(null); setForm({ display_name: '', login_id: '', password: '', email: '', area: '東京' }); setShowForm(true); };
  const openEdit = (a) => { setEditTarget(a); setForm({ display_name: a.display_name, login_id: a.login_id, password: '', email: a.email || '', area: a.area || '東京' }); setShowForm(true); };
  const closeForm = () => { setShowForm(false); setEditTarget(null); };

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true);
    try {
      if (editTarget) {
        const payload = { display_name: form.display_name, login_id: form.login_id, email: form.email, area: form.area };
        if (form.password) payload.password = form.password;
        await api.updateAdmin(editTarget.id, payload);
        addToast('管理者情報を更新しました');
      } else {
        await api.createAdmin(form);
        addToast('管理者を追加しました');
      }
      await load(); closeForm();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const handleDelete = async (a) => {
    if (!confirm(`管理者「${a.display_name}」を削除しますか？`)) return;
    try { await api.deleteAdmin(a.id); addToast('削除しました'); await load(); }
    catch (err) { addToast(err.message, 'error'); }
  };

  return (
    <>
      <div style={{ padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, marginBottom: 16, fontSize: '0.78rem', color: 'var(--text-sub)', lineHeight: 1.6 }}>
        管理者は複数登録できます。各管理者にエリア（東京・大阪）を設定すると、ログイン時にデフォルトでそのエリアの案件のみが表示されます。
      </div>

      <button className="btn btn-primary btn-sm" style={{ marginBottom: 16 }} onClick={openAdd}>+ 管理者を追加</button>

      {showForm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--glass-border)',
            borderRadius: 20, padding: 24, width: '100%', maxWidth: 380 }}>
            <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 20 }}>
              {editTarget ? '管理者情報を編集' : '管理者を追加'}
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>表示名 *</label>
                <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                  placeholder="鈴木 一郎" required />
              </div>
              <div className="form-group">
                <label>ログインID *</label>
                <input value={form.login_id} onChange={e => setForm(f => ({ ...f, login_id: e.target.value }))}
                  placeholder="suzuki" required style={{ fontFamily: 'monospace' }} />
              </div>
              <div className="form-group">
                <label>{editTarget ? '新しいパスワード（変更する場合のみ）' : 'パスワード *'}</label>
                <input type="password" value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder={editTarget ? '変更しない場合は空白' : 'パスワードを入力'}
                  required={!editTarget} />
              </div>
              <div className="form-group">
                <label>メールアドレス</label>
                <input type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="suzuki@example.com" />
              </div>
              <div className="form-group">
                <label>担当エリア *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['東京', '大阪'].map(a => (
                    <label key={a} style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      cursor: 'pointer', padding: '10px 12px', borderRadius: 8,
                      background: form.area === a ? 'rgba(59,130,246,0.15)' : 'var(--card-bg)',
                      border: `1px solid ${form.area === a ? 'var(--accent)' : 'var(--border)'}`,
                    }}>
                      <input type="radio" name="admin_area" value={a} checked={form.area === a}
                        onChange={() => setForm(f => ({ ...f, area: a }))} style={{ width: 'auto', margin: 0 }} />
                      <span style={{ fontSize: '0.88rem' }}>📍 {a}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={closeForm}>キャンセル</button>
                <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={loading}>
                  {loading ? '保存中...' : editTarget ? '更新' : '追加'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {admins.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>管理者がいません</div>
      ) : admins.map(a => (
        <div key={a.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--navy)',
            border: '1px solid var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flexShrink: 0 }}>
            🔑
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontWeight: 600 }}>{a.display_name}</span>
              <span style={{ fontSize: '0.68rem', padding: '1px 7px', borderRadius: 99, background: 'rgba(59,130,246,0.15)', color: 'var(--accent-lt)' }}>
                📍 {a.area || '東京'}
              </span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', fontFamily: 'monospace' }}>
              ID: {a.login_id}
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {a.email ? `📧 ${a.email}` : '📧 未設定'}
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(a)}>編集</button>
          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(a)}>削除</button>
        </div>
      ))}
    </>
  );
}

function BlockedTab({ addToast }) {
  const [blocked, setBlocked] = useState([]);
  const [areaFilter, setAreaFilter] = useState('東京');
  const [form, setForm] = useState({ date: '', time_from: '', time_to: '', reason: '', area: '東京' });
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = (area) => api.getBlockedDates(area).then(setBlocked);
  useEffect(() => { load(areaFilter); }, [areaFilter]);

  const handleAdd = async (e) => {
    e.preventDefault(); setLoading(true);
    try {
      await api.createBlockedDate(form);
      addToast(`${form.area}の予定不可日を設定しました`);
      setForm({ date: '', time_from: '', time_to: '', reason: '', area: areaFilter });
      setShowForm(false);
      await load(areaFilter);
    } catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('この予定不可日を削除しますか？')) return;
    await api.deleteBlockedDate(id);
    addToast('削除しました');
    await load(areaFilter);
  };

  const openForm = () => {
    setForm(f => ({ ...f, area: areaFilter }));
    setShowForm(v => !v);
  };

  return (
    <>
      <div style={{ padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8, marginBottom: 16, fontSize: '0.78rem', color: 'var(--text-sub)', lineHeight: 1.6 }}>
        予定不可日はエリアごとに独立して管理されます。東京で予定不可でも、大阪では予定OKとして登録できます。
      </div>

      {/* エリア切り替え */}
      <div className="filter-bar" style={{ marginBottom: 16 }}>
        {['東京', '大阪'].map(a => (
          <button key={a} className={`filter-chip ${areaFilter === a ? 'active' : ''}`} onClick={() => setAreaFilter(a)}>
            📍 {a}
          </button>
        ))}
      </div>

      <button className="btn btn-primary btn-sm" style={{ marginBottom: 16 }} onClick={openForm}>
        {showForm ? '▲ 閉じる' : `+ ${areaFilter}の予定不可日を追加`}
      </button>
      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <form onSubmit={handleAdd}>
            <div className="form-group">
              <label>エリア *</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['東京', '大阪'].map(a => (
                  <label key={a} style={{
                    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    cursor: 'pointer', padding: '10px 12px', borderRadius: 8,
                    background: form.area === a ? 'rgba(239,68,68,0.12)' : 'var(--card-bg)',
                    border: `1px solid ${form.area === a ? 'var(--danger)' : 'var(--border)'}`,
                  }}>
                    <input type="radio" name="blocked_area" value={a} checked={form.area === a}
                      onChange={() => setForm(f => ({ ...f, area: a }))} style={{ width: 'auto', margin: 0 }} />
                    <span style={{ fontSize: '0.88rem' }}>📍 {a}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label>日付 *</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div className="form-group">
                <label>開始時刻（任意）</label>
                <input type="time" value={form.time_from} onChange={e => setForm(f => ({ ...f, time_from: e.target.value }))} />
              </div>
              <div className="form-group">
                <label>終了時刻（任意）</label>
                <input type="time" value={form.time_to} onChange={e => setForm(f => ({ ...f, time_to: e.target.value }))} />
              </div>
            </div>
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label>理由（任意）</label>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="社内行事、定休日など" />
            </div>
            <button type="submit" className="btn btn-danger btn-sm" disabled={loading}>
              {loading ? '設定中...' : `${form.area}の予定不可日を設定`}
            </button>
          </form>
        </div>
      )}
      {blocked.length === 0 ? (
        <div className="empty-state" style={{ padding: '32px 16px' }}>{areaFilter}の予定不可日は設定されていません</div>
      ) : blocked.map(b => (
        <div key={b.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'var(--danger)', fontWeight: 600, fontSize: '0.9rem' }}>
              🚫 {b.date}{b.time_from ? ` ${b.time_from}〜${b.time_to || ''}` : '（終日）'}
            </div>
            {b.reason && <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)', marginTop: 2 }}>{b.reason}</div>}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(b.id)}>削除</button>
        </div>
      ))}
    </>
  );
}

// ── メール設定 ────────────────────────────────────────────────
function EmailTab({ addToast }) {
  const [settings, setSettings] = useState({ provider: 'gmail_api', gmail_user: '', gmail_app_password: '', notify_emails: [], from: '' });
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => { api.getEmailSettings().then(setSettings); }, []);

  const setField = (k, v) => setSettings(s => ({ ...s, [k]: v }));
  const addEmail = () => {
    const email = newEmail.trim();
    if (!email || !email.includes('@')) { addToast('有効なメールアドレスを入力してください', 'error'); return; }
    if ((settings.notify_emails || []).includes(email)) { addToast('すでに登録されています', 'error'); return; }
    setSettings(s => ({ ...s, notify_emails: [...(s.notify_emails || []), email] }));
    setNewEmail('');
  };
  const removeEmail = (email) => setSettings(s => ({ ...s, notify_emails: (s.notify_emails || []).filter(e => e !== email) }));

  const handleSave = async () => {
    setLoading(true);
    try { await api.updateEmailSettings(settings); addToast('メール設定を保存しました'); }
    catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };
  const handleTest = async () => {
    setTesting(true);
    try { await api.testEmail(); addToast('テストメールを送信しました！'); }
    catch (err) { addToast(`送信失敗：${err.message}`, 'error'); }
    finally { setTesting(false); }
  };

  return (
    <>
      <div className="card">
        <div className="section-title">メール送信方法</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { value: 'gmail_api', label: '🔑 Gmail API（OAuth2）', sub: '推奨 — 独自ドメイン不要・Render無料枠でも動作（環境変数に GMAIL_CLIENT_ID 等を設定）' },
            { value: 'gmail_smtp', label: '📨 Gmail SMTP', sub: '独自ドメイン不要だが Render 有料プランが必要' },
            { value: 'resend', label: '⚡ Resend API', sub: '独自ドメイン必要' },
          ].map(opt => (
            <label key={opt.value} style={{
              display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer',
              padding: '12px 14px', borderRadius: 10,
              background: (settings.provider || 'gmail_api') === opt.value ? 'rgba(59,130,246,0.12)' : 'var(--card-bg)',
              border: `1px solid ${(settings.provider || 'gmail_api') === opt.value ? 'var(--accent)' : 'var(--border)'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="radio" name="provider" value={opt.value}
                  checked={(settings.provider || 'gmail_api') === opt.value}
                  onChange={() => setField('provider', opt.value)} style={{ width: 'auto', margin: 0 }} />
                <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{opt.label}</span>
              </div>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-sub)', paddingLeft: 22 }}>{opt.sub}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Gmail API 設定確認 */}
      {(settings.provider || 'gmail_api') === 'gmail_api' && (
        <div className="card">
          <div className="section-title">Gmail API 設定状態</div>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-sub)', lineHeight: 1.8 }}>
            以下の環境変数を Render.com のダッシュボードで設定してください。
          </div>
          {[
            { key: 'GMAIL_CLIENT_ID', label: 'クライアントID', hint: 'GCP OAuth2 クライアントID' },
            { key: 'GMAIL_CLIENT_SECRET', label: 'クライアントシークレット', hint: 'GCP OAuth2 シークレット' },
            { key: 'GMAIL_REFRESH_TOKEN', label: 'リフレッシュトークン', hint: 'OAuth Playground で取得' },
            { key: 'GMAIL_SENDER_ADDRESS', label: '送信者メールアドレス', hint: '例: your@gmail.com' },
          ].map(item => (
            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: 'var(--accent-lt)' }}>{item.key}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)' }}>{item.hint}</div>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 12, padding: '8px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, fontSize: '0.75rem', color: 'var(--text-sub)', lineHeight: 1.7 }}>
            ⚠️ OAuthの同意画面を「本番環境」に設定してください。「テスト」のままだとリフレッシュトークンが7日で失効します。
          </div>
        </div>
      )}

      {/* Gmail SMTP 設定 */}
      {settings.provider === 'gmail_smtp' && (
        <div className="card">
          <div className="section-title">Gmail SMTP 設定</div>
          <div className="form-group">
            <label>Gmailアドレス *</label>
            <input type="email" value={settings.gmail_user || ''} onChange={e => setField('gmail_user', e.target.value)} placeholder="your-account@gmail.com" />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>アプリパスワード * （16文字）</label>
            <input type="password" value={settings.gmail_app_password || ''} onChange={e => setField('gmail_app_password', e.target.value)} placeholder="xxxx xxxx xxxx xxxx" />
          </div>
        </div>
      )}

      {/* Resend 設定 */}
      {settings.provider === 'resend' && (
        <div className="card">
          <div className="section-title">Resend 設定</div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>送信元アドレス（From）</label>
            <input type="email" value={settings.from || ''} onChange={e => setField('from', e.target.value)} placeholder="noreply@your-domain.com" />
          </div>
        </div>
      )}

      <div className="card">
        <div className="section-title">通知先メールアドレス（CS部管理者）</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
            placeholder="manager@example.com" onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addEmail())} style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary btn-sm" onClick={addEmail}>追加</button>
        </div>
        {(settings.notify_emails || []).length === 0 ? (
          <div className="text-sub" style={{ fontSize: '0.8rem' }}>通知先が登録されていません</div>
        ) : (settings.notify_emails || []).map(email => (
          <div key={email} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ fontSize: '0.88rem' }}>📧 {email}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => removeEmail(email)}>削除</button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-ghost" style={{ flex: 1 }} onClick={handleTest} disabled={testing}>{testing ? '送信中...' : '📨 テスト送信（設定確認）'}</button>
        <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave} disabled={loading}>{loading ? '保存中...' : '設定を保存'}</button>
      </div>
    </>
  );
}

// ── メールテンプレート編集 ─────────────────────────────────────
const TEMPLATE_LABELS = {
  schedule_proposed:   { label: '📝 新規依頼通知', desc: '営業が案件を登録したとき' },
  candidates_set:      { label: '🗓 候補日設定完了', desc: '管理者が候補日の設定を完了したとき' },
  schedule_confirmed:  { label: '✅ スケジュール確定', desc: '営業が候補日を確定したとき' },
  schedule_cancelled:  { label: '❌ キャンセル通知', desc: '案件がキャンセルされたとき' },
  reminder:            { label: '🔔 リマインド', desc: '営業がリマインドボタンを押したとき' },
  auto_cancel_warning: { label: '⚠️ 自動キャンセル警告', desc: '強制キャンセル前日の通知' },
  auto_cancelled:      { label: '⏰ 自動キャンセル通知', desc: '10営業日経過で自動キャンセルされたとき' },
  cs_members_changed:  { label: '🔁 CS担当変更', desc: '管理者が確定済み案件のCS担当者を変更したとき' },
  confirm_reminder:    { label: '📣 日程確定の催促', desc: '管理者が仮スケ設定済み案件の営業担当へ確定を催促したとき' },
};
const AVAILABLE_VARS = {
  schedule_proposed:   ['case_id', 'project_type', 'client_name', 'sales_rep', 'delivery_method', 'candidate_days', 'memo', 'detail_url'],
  candidates_set:      ['case_id', 'project_type', 'client_name', 'sales_rep', 'delivery_method', 'cs_members', 'candidate_list', 'detail_url'],
  schedule_confirmed:  ['case_id', 'project_type', 'client_name', 'sales_rep', 'delivery_method', 'cs_members', 'confirmed_date', 'shortage_reason_line', 'detail_url'],
  schedule_cancelled:  ['case_id', 'project_type', 'client_name', 'sales_rep', 'confirmed_date', 'cs_members', 'cancel_reason', 'detail_url'],
  reminder:            ['case_id', 'project_type', 'client_name', 'sales_rep', 'candidate_days', 'created_at', 'detail_url'],
  auto_cancel_warning: ['case_id', 'project_type', 'client_name', 'sales_rep', 'deadline_date', 'detail_url'],
  auto_cancelled:      ['case_id', 'project_type', 'client_name', 'sales_rep', 'detail_url'],
  cs_members_changed:  ['case_id', 'project_type', 'client_name', 'sales_rep', 'confirmed_date', 'old_cs_members', 'new_cs_members', 'detail_url'],
  confirm_reminder:    ['case_id', 'project_type', 'client_name', 'sales_rep', 'candidate_days', 'candidate_list', 'detail_url'],
};

function TemplatesTab({ addToast }) {
  const [templates, setTemplates] = useState({});
  const [activeKey, setActiveKey] = useState('schedule_proposed');
  const [loading, setLoading] = useState(false);

  const load = () => api.getEmailTemplates().then(setTemplates);
  useEffect(() => { load(); }, []);

  const current = templates[activeKey] || { subject: '', body: '' };

  const setCurrent = (field, value) => {
    setTemplates(t => ({ ...t, [activeKey]: { ...t[activeKey], [field]: value } }));
  };

  const handleSave = async () => {
    setLoading(true);
    try { await api.updateEmailTemplates(templates); addToast('メール文面を保存しました'); }
    catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const handleReset = async () => {
    if (!confirm('このメール文面を初期状態に戻しますか？')) return;
    setLoading(true);
    try {
      const defaults = await api.resetEmailTemplates();
      setTemplates(defaults);
      addToast('初期文面に戻しました');
    } catch (err) { addToast(err.message, 'error'); }
    finally { setLoading(false); }
  };

  const insertVar = (varName) => {
    setCurrent('body', (current.body || '') + `{{${varName}}}`);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
        {Object.entries(TEMPLATE_LABELS).map(([key, { label }]) => (
          <button key={key}
            className={`filter-chip ${activeKey === key ? 'active' : ''}`}
            onClick={() => setActiveKey(key)}
            style={{ flexShrink: 0 }}>
            {label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="section-title">{TEMPLATE_LABELS[activeKey]?.label}</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)', marginBottom: 14 }}>
          {TEMPLATE_LABELS[activeKey]?.desc}
        </div>

        <div className="form-group">
          <label>メールタイトル</label>
          <input value={current.subject || ''} onChange={e => setCurrent('subject', e.target.value)} />
        </div>

        <div className="form-group" style={{ marginBottom: 10 }}>
          <label>本文</label>
          <textarea
            value={current.body || ''}
            onChange={e => setCurrent('body', e.target.value)}
            style={{ minHeight: 200, fontFamily: 'monospace', fontSize: '0.85rem' }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', marginBottom: 6 }}>挿入できる変数（タップで本文に追加）：</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(AVAILABLE_VARS[activeKey] || []).map(v => (
              <button key={v} type="button" onClick={() => insertVar(v)}
                style={{
                  fontFamily: 'monospace', fontSize: '0.72rem', padding: '4px 8px', borderRadius: 6,
                  background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)',
                  color: 'var(--accent-lt)', cursor: 'pointer',
                }}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={handleReset} disabled={loading}>初期文面に戻す</button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave} disabled={loading}>
            {loading ? '保存中...' : 'すべての文面を保存'}
          </button>
        </div>
      </div>
    </>
  );
}
