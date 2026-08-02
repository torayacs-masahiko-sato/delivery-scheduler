import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { StatusBadge, formatDate, relativeTime } from '../components/StatusBadge';
import StaffPicker from '../components/StaffPicker';

const DELIVERY_ICONS = { remote: '🖥', onsite: '🚗' };
const AREAS = ['東京', '大阪'];

const STATUS_FILTERS = [
  { key: 'pending',   label: '候補日待ち' },
  { key: 'scheduled', label: '仮スケ設定済' },
  { key: 'confirmed', label: '確定済み' },
  { key: 'cancelled', label: 'キャンセル' },
];

// 削除機能を許可するステータス（管理者のみ）
const DELETABLE_STATUSES = ['confirmed', 'cancelled'];

export default function DashboardPage({ onNavigate }) {
  const { user } = useAuth();
  // デフォルトは「候補日待ち」（営業・管理者共通）
  const [statusFilter, setStatusFilter] = useState('pending');
  // 管理者用：表示対象メンバー（'all' または 営業の display_name）
  const [memberFilter, setMemberFilter] = useState('all');
  // 管理者用：表示対象CS部員（'all' または CS部員の display_name）
  const [csFilter, setCsFilter] = useState('all');
  // 管理者用：エリアフィルター（デフォルトは自分のエリアのみ）
  const [areaFilter, setAreaFilter] = useState(user.area || '東京');
  const [salesUsers, setSalesUsers] = useState([]);
  const [csMembers, setCsMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [showSalesPicker, setShowSalesPicker] = useState(false);
  const [showCsPicker, setShowCsPicker] = useState(false);

  // 選択削除モード
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [deleting, setDeleting] = useState(false);

  const load = () => {
    const calls = [api.getProjects(), api.getStats()];
    if (user.role === 'admin') calls.push(api.getUsers(), api.getCsMembers());
    return Promise.all(calls).then(([p, s, u, cs]) => {
      setProjects(p);
      setStats(s);
      if (u) setSalesUsers(u);
      if (cs) setCsMembers(cs);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // ステータス切り替え時は選択モードをリセット
  useEffect(() => {
    setSelectMode(false);
    setSelectedIds([]);
  }, [statusFilter]);

  // display_name → area のマップ（管理者がエリア絞り込みに使用）
  const areaByName = {};
  salesUsers.forEach(u => { areaByName[u.display_name] = u.area || '東京'; });

  const filtered = projects.filter(p => {
    if (p.status !== statusFilter) return false;
    if (user.role === 'sales') return p.sales_rep === user.name;

    // 管理者：CS部員個別指定があれば対象案件を絞り込み（案件レベル・候補日レベルどちらのCS割当も対象）
    if (csFilter !== 'all') {
      const projectCs = p.cs_members || [];
      const candidateCs = (p.candidates || []).flatMap(c => c.cs_members || []);
      if (!projectCs.includes(csFilter) && !candidateCs.includes(csFilter)) return false;
    }

    // 管理者：メンバー個別指定があれば最優先
    if (memberFilter !== 'all') return p.sales_rep === memberFilter;

    // 管理者：エリアフィルター（'all'なら全エリア）
    if (areaFilter === 'all') return true;
    return (areaByName[p.sales_rep] || '東京') === areaFilter;
  });

  const visibleSalesUsers = user.role === 'admin' && areaFilter !== 'all'
    ? salesUsers.filter(u => (u.area || '東京') === areaFilter)
    : salesUsers;

  const pageSubText = user.role === 'sales'
    ? `${user.name}の案件`
    : [
        memberFilter !== 'all' ? `${memberFilter}の案件` : (areaFilter === 'all' ? '全エリアの案件' : `${areaFilter}エリアの案件`),
        csFilter !== 'all' ? `（CS：${csFilter}）` : '',
      ].join('');

  const canDelete = (user.role === 'admin' || user.role === 'sales') && DELETABLE_STATUSES.includes(statusFilter);

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const selectAll = () => setSelectedIds(filtered.map(p => p.id));
  const clearSelection = () => setSelectedIds([]);

  const handleBulkDeleteSelected = async () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`選択した${selectedIds.length}件の案件を削除しますか？\nこの操作は取り消せません。`)) return;
    setDeleting(true);
    try {
      await api.bulkDeleteProjects(selectedIds, user.login_id);
      setSelectedIds([]);
      setSelectMode(false);
      await load();
    } catch (err) {
      alert(err.message);
    } finally { setDeleting(false); }
  };

  const handleDeleteAllInStatus = async () => {
    const label = STATUS_FILTERS.find(f => f.key === statusFilter)?.label || statusFilter;
    const count = filtered.length;
    if (count === 0) return;
    const scopeText = user.role === 'sales' ? '自分が担当する' : '現在の絞り込み条件（メンバー・エリア）に一致する';
    if (!confirm(`「${label}」の案件を全て削除しますか？（${count}件）\n※${scopeText}案件が全て対象です。\nこの操作は取り消せません。`)) return;
    setDeleting(true);
    try {
      // 現在のフィルタ条件に一致するIDのみ削除（表示中のものだけ安全に削除）
      const idsToDelete = filtered.map(p => p.id);
      await api.bulkDeleteProjects(idsToDelete, user.login_id);
      setSelectedIds([]);
      setSelectMode(false);
      await load();
    } catch (err) {
      alert(err.message);
    } finally { setDeleting(false); }
  };

  return (
    <>
      <div className="page-title">ダッシュボード</div>
      <div className="page-sub">{pageSubText}</div>

      {user.role === 'admin' && (
        <div className="stats-grid">
          <div className="stat-card"><div className="stat-value">{stats.total ?? '—'}</div><div className="stat-label">総案件数</div></div>
          <div
            className="stat-card"
            role="button" tabIndex={0}
            onClick={() => setStatusFilter('pending')}
            onKeyDown={e => { if (e.key === 'Enter') setStatusFilter('pending'); }}
            style={{ cursor: 'pointer', outline: statusFilter === 'pending' ? '2px solid var(--warning)' : 'none' }}
          >
            <div className="stat-value" style={{ color: 'var(--warning)' }}>{stats.pending ?? '—'}</div><div className="stat-label">候補日待ち</div>
          </div>
          <div
            className="stat-card"
            role="button" tabIndex={0}
            onClick={() => setStatusFilter('scheduled')}
            onKeyDown={e => { if (e.key === 'Enter') setStatusFilter('scheduled'); }}
            style={{ cursor: 'pointer', outline: statusFilter === 'scheduled' ? '2px solid var(--accent-lt)' : 'none' }}
          >
            <div className="stat-value" style={{ color: 'var(--accent-lt)' }}>{stats.scheduled ?? '—'}</div><div className="stat-label">仮スケ設定済</div>
          </div>
          <div
            className="stat-card"
            role="button" tabIndex={0}
            onClick={() => setStatusFilter('confirmed')}
            onKeyDown={e => { if (e.key === 'Enter') setStatusFilter('confirmed'); }}
            style={{ cursor: 'pointer', outline: statusFilter === 'confirmed' ? '2px solid var(--success)' : 'none' }}
          >
            <div className="stat-value" style={{ color: 'var(--success)' }}>{stats.confirmed ?? '—'}</div><div className="stat-label">確定済み</div>
          </div>
        </div>
      )}

      {/* 管理者専用：エリア切り替え（デフォルトは自分のエリア） */}
      {user.role === 'admin' && (
        <div className="filter-bar">
          {AREAS.map(a => (
            <button key={a} className={`filter-chip ${areaFilter === a ? 'active' : ''}`}
              onClick={() => { setAreaFilter(a); setMemberFilter('all'); }}>
              📍 {a}
            </button>
          ))}
          <button className={`filter-chip ${areaFilter === 'all' ? 'active' : ''}`}
            onClick={() => { setAreaFilter('all'); setMemberFilter('all'); }}>
            🌐 全エリア
          </button>
        </div>
      )}

      {/* 管理者専用：営業メンバー・CS部員をリストから選択して絞り込み */}
      {user.role === 'admin' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <button
              type="button"
              className={`picker-trigger${memberFilter === 'all' ? ' empty' : ''}`}
              onClick={() => setShowSalesPicker(true)}
            >
              <span className="picker-trigger-chips">
                {memberFilter !== 'all'
                  ? <span className="picker-trigger-chip">👤 {memberFilter}</span>
                  : '👤 営業：全メンバー'}
              </span>
              <span className="picker-trigger-arrow">▼</span>
            </button>
            {showSalesPicker && (
              <StaffPicker
                title="営業メンバーで絞り込み"
                members={visibleSalesUsers}
                value={memberFilter !== 'all' ? [memberFilter] : []}
                onChange={(names) => setMemberFilter(names[0] || 'all')}
                onClose={() => setShowSalesPicker(false)}
                multi={false}
              />
            )}
          </div>
          <div style={{ flex: 1 }}>
            <button
              type="button"
              className={`picker-trigger${csFilter === 'all' ? ' empty' : ''}`}
              onClick={() => setShowCsPicker(true)}
            >
              <span className="picker-trigger-chips">
                {csFilter !== 'all'
                  ? <span className="picker-trigger-chip">🛠 {csFilter}</span>
                  : '🛠 CS：全員'}
              </span>
              <span className="picker-trigger-arrow">▼</span>
            </button>
            {showCsPicker && (
              <StaffPicker
                title="CS部員で絞り込み"
                members={csMembers}
                value={csFilter !== 'all' ? [csFilter] : []}
                onChange={(names) => setCsFilter(names[0] || 'all')}
                onClose={() => setShowCsPicker(false)}
                multi={false}
              />
            )}
          </div>
          {(memberFilter !== 'all' || csFilter !== 'all') && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setMemberFilter('all'); setCsFilter('all'); }}>
              クリア
            </button>
          )}
        </div>
      )}

      {/* ステータスフィルター */}
      <div className="filter-bar">
        {STATUS_FILTERS.map(f => (
          <button key={f.key} className={`filter-chip ${statusFilter === f.key ? 'active' : ''}`} onClick={() => setStatusFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {/* 削除操作バー（確定済み・キャンセルタブでのみ表示。営業は自分の案件のみ削除可能） */}
      {canDelete && filtered.length > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8,
          padding: '10px 12px', marginBottom: 12, borderRadius: 10,
          background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)',
        }}>
          {user.role === 'sales' && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)' }}>
              ご自身が担当する案件のみ削除できます
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {!selectMode ? (
            <>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelectMode(true)}>
                🗑 データ選択削除
              </button>
              <button className="btn btn-danger btn-sm" onClick={handleDeleteAllInStatus} disabled={deleting}>
                {deleting ? '削除中...' : `🗑 データ一括削除（${filtered.length}件）`}
              </button>
            </>
          ) : (
            <>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-sub)' }}>
                {selectedIds.length}件を選択中
              </span>
              <button className="btn btn-ghost btn-sm" onClick={selectAll}>全て選択</button>
              <button className="btn btn-ghost btn-sm" onClick={clearSelection}>選択解除</button>
              <button className="btn btn-danger btn-sm" onClick={handleBulkDeleteSelected}
                disabled={deleting || selectedIds.length === 0}>
                {deleting ? '削除中...' : `選択した${selectedIds.length}件を削除`}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setSelectMode(false); setSelectedIds([]); }}>
                キャンセル
              </button>
            </>
          )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-state">読み込み中...</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M20 7H4a2 2 0 00-2 2v9a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/>
            <path d="M16 3H8a2 2 0 00-2 2v2h12V5a2 2 0 00-2-2z"/>
          </svg>
          <div>案件がありません</div>
        </div>
      ) : (
        filtered.map(project => (
          <ProjectCard
            key={project.id}
            project={project}
            onNavigate={onNavigate}
            selectMode={selectMode}
            selected={selectedIds.includes(project.id)}
            onToggleSelect={() => toggleSelect(project.id)}
          />
        ))
      )}
    </>
  );
}

function ProjectCard({ project, onNavigate, selectMode, selected, onToggleSelect }) {
  const hasCandidates = project.candidates?.length > 0;
  const hasConfirmed  = !!project.confirmed_date && project.status === 'confirmed';
  const isCancelled = project.status === 'cancelled';

  const handleClick = () => {
    if (selectMode) onToggleSelect();
    else onNavigate('detail', project.id);
  };

  return (
    <div className="card" onClick={handleClick} style={{
      cursor: 'pointer',
      position: 'relative',
      border: selectMode && selected ? '2px solid var(--danger)' : undefined,
      background: selectMode && selected ? 'rgba(239,68,68,0.06)' : undefined,
    }}>
      {selectMode && (
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <input type="checkbox" checked={selected} onChange={onToggleSelect}
            onClick={e => e.stopPropagation()}
            style={{ width: 20, height: 20, cursor: 'pointer' }} />
        </div>
      )}

      <div className="card-header">
        <div>
          <div className="project-name">{project.project_type || '—'}</div>
          <div className="client-name">{project.client_name}</div>
          {project.case_id && (
            <div style={{ fontSize: '0.68rem', color: 'var(--text-sub)', fontFamily: 'monospace', marginTop: 2 }}>
              🆔 {project.case_id}
            </div>
          )}
        </div>
        {!selectMode && <StatusBadge status={project.status} />}
      </div>

      <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)', display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span>👤 {project.sales_rep}</span>
        <span>{DELIVERY_ICONS[project.delivery_method] || ''} {project.delivery_method === 'onsite' ? '現地訪問' : 'リモート'}</span>
        <span style={{ marginLeft: 'auto' }}>{relativeTime(project.updated_at)}</span>
      </div>

      {isCancelled && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', fontSize: '0.8rem', color: 'var(--danger)' }}>
          理由：{project.cancel_reason || '—'}
        </div>
      )}

      {hasConfirmed && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)' }}>
          <span>✅</span>
          <div>
            <div style={{ fontSize: '0.68rem', color: 'var(--success)', marginBottom: 1 }}>確定日</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--success)' }}>{formatDate(project.confirmed_date)}</div>
          </div>
        </div>
      )}

      {hasCandidates && !hasConfirmed && !isCancelled && (
        <div>
          <div style={{ fontSize: '0.68rem', color: 'var(--text-sub)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 6 }}>候補日</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {project.candidates.map((c, i) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6, background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.15)' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--accent-lt)', fontWeight: 700, minWidth: 42 }}>第{i + 1}候補</span>
                <span style={{ fontSize: '0.86rem', color: 'var(--text)' }}>
                  {formatDate(c.candidate_date)}
                  {c.candidate_time && <span style={{ color: 'var(--text-sub)', marginLeft: 8 }}>{c.candidate_time}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!hasCandidates && !hasConfirmed && !isCancelled && (
        <div style={{ padding: '6px 10px', borderRadius: 6, background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.2)', fontSize: '0.8rem', color: 'var(--warning)' }}>
          🗓 候補日の設定待ち（希望：{project.candidate_days || 1}日）
        </div>
      )}
    </div>
  );
}
