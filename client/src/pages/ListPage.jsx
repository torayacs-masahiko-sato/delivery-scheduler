// 管理者用「案件一覧」：全案件を表（Excelのような形）で表示する。
// ・月ごと（予定日 or 登録日）／担当営業ごと／CS担当ごとのまとめ表示と件数
// ・担当営業・CS担当・月・ステータス・キーワードでの絞り込み、列見出しクリックで並べ替え
// ・表示中の内容をExcelで開ける形式（CSV）でダウンロード
// データは既存の案件APIをそのまま使う（サーバー側の変更なし）。
import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { StatusBadge, STATUS_MAP } from '../components/StatusBadge';
import { DELIVERY_LABELS } from '../constants';

const STATUS_ORDER = ['pending', 'scheduled', 'confirmed', 'delivered', 'cancelled'];
const UNDATED = '日程未定';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

// 絞り込み条件は、詳細画面から戻ったときに元に戻せるよう、このブラウザのタブ内だけに保存する
const STORE_KEY = 'ds_list_filters';
const loadFilters = () => { try { return JSON.parse(sessionStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };
const saveFilters = (f) => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(f)); } catch { /* 保存できなくても動作に支障なし */ } };

// ── 日付の扱い ─────────────────────────────────
const jstYmd = (iso) => { try { return new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); } catch { return ''; } };
const ymdOf = (s) => (String(s || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
const timeOf = (s) => (String(s || '').match(/\d{2}:\d{2}/) || [''])[0];
const shortDate = (ymd) => {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const w = WEEK[new Date(y, m - 1, d).getDay()];
  return `${y}/${m}/${d}(${w})`;
};
const monthLabel = (key) => key === UNDATED ? UNDATED : `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`;

/** 予定日：確定済み・納品済みは確定日、それ以外は最も早い候補日（候補日がなければ未定） */
function plannedOf(p) {
  if (['confirmed', 'delivered'].includes(p.status) && p.confirmed_date) {
    return { ymd: ymdOf(p.confirmed_date), time: timeOf(p.confirmed_date), extra: 0, confirmed: true };
  }
  const cands = (p.candidates || []).filter(c => c.candidate_date).slice()
    .sort((a, b) => `${a.candidate_date} ${a.candidate_time || ''}`.localeCompare(`${b.candidate_date} ${b.candidate_time || ''}`));
  if (!cands.length) return { ymd: '', time: '', extra: 0, confirmed: false };
  return { ymd: cands[0].candidate_date, time: cands[0].candidate_time || '', extra: cands.length - 1, confirmed: false };
}
/** CS担当：確定後は案件のCS担当、確定前は候補日に割り当てたCS部員をまとめたもの */
function csOf(p) {
  const fromProject = p.cs_members || [];
  if (fromProject.length) return fromProject;
  return [...new Set((p.candidates || []).flatMap(c => c.cs_members || []))];
}

// 1行分の表示・並べ替え・CSV用データ
function toRow(p) {
  const planned = plannedOf(p);
  const urls = (p.client_urls || []).filter(u => u.url);
  return {
    id: p.id,
    case_id: p.case_id || '',
    status: p.status,
    statusLabel: STATUS_MAP[p.status]?.label || p.status,
    client_name: p.client_name || '',
    project_type: p.project_type || '',
    sales_rep: p.sales_rep || '',
    requested_by: p.requested_by && p.requested_by !== p.sales_rep ? p.requested_by : '',
    delivery: DELIVERY_LABELS[p.delivery_method] || p.delivery_method || '',
    deliveryPlain: p.delivery_method === 'onsite' ? '現地訪問' : p.delivery_method === 'remote' ? 'リモート' : '',
    plannedYmd: planned.ymd,
    plannedText: planned.ymd
      ? `${shortDate(planned.ymd)}${planned.time ? ' ' + planned.time : ''}${planned.confirmed ? '' : '（候補）'}${planned.extra ? ` 他${planned.extra}件` : ''}`
      : '',
    plannedSort: planned.ymd ? `${planned.ymd} ${planned.time}` : '9999',
    cs: csOf(p),
    // 候補日の件数/希望日数は、候補日待ち・仮スケ設定済みのときだけ意味がある（確定すると候補日は整理されるため）
    days: ['pending', 'scheduled'].includes(p.status) ? `${(p.candidates || []).length}/${p.candidate_days || 1}` : '—',
    memo: p.memo || '',
    urls,
    createdYmd: jstYmd(p.created_at),
    updatedYmd: jstYmd(p.updated_at),
    raw: p,
  };
}

// 列の定義（表示・並べ替え・CSVで共通）
const COLUMNS = [
  { key: 'case_id', label: '案件ID', sort: r => r.case_id, csv: r => r.case_id },
  { key: 'status', label: 'ステータス', sort: r => STATUS_ORDER.indexOf(r.status), csv: r => r.statusLabel },
  { key: 'client_name', label: '顧客名', sort: r => r.client_name, csv: r => r.client_name },
  { key: 'project_type', label: '案件内容', sort: r => r.project_type, csv: r => r.project_type },
  { key: 'sales_rep', label: '担当営業', sort: r => r.sales_rep, csv: r => r.sales_rep },
  { key: 'requested_by', label: '依頼した営業', sort: r => r.requested_by, csv: r => r.requested_by },
  { key: 'delivery', label: '納品方法', sort: r => r.deliveryPlain, csv: r => r.deliveryPlain },
  { key: 'planned', label: '予定日時', sort: r => r.plannedSort, csv: r => r.plannedText },
  { key: 'cs', label: 'CS担当', sort: r => r.cs.join('、'), csv: r => r.cs.join('、') },
  { key: 'days', label: '候補日/希望', sort: r => r.days, csv: r => r.days },
  { key: 'memo', label: '備考', sort: r => r.memo, csv: r => r.memo },
  { key: 'urls', label: '関連URL', sort: r => r.urls.length, csv: r => r.urls.map(u => (u.label ? `${u.label}：` : '') + u.url).join(' / ') },
  { key: 'created', label: '登録日', sort: r => r.createdYmd, csv: r => r.createdYmd },
  { key: 'updated', label: '最終更新', sort: r => r.updatedYmd, csv: r => r.updatedYmd },
];

function downloadCsv(rows, filenameBase) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [COLUMNS.map(c => esc(c.label)).join(',')]
    .concat(rows.map(r => COLUMNS.map(c => esc(c.csv(r))).join(',')));
  // 先頭のBOMは、Excelで開いたときに文字化けしないようにするため
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${filenameBase}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ListPage({ onNavigate, addToast }) {
  const saved = loadFilters();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');
  const [groupBy, setGroupBy] = useState(saved.groupBy || 'none');           // none | month | sales | cs
  const [monthBasis, setMonthBasis] = useState(saved.monthBasis || 'planned'); // planned | created
  const [month, setMonth] = useState(saved.month || '');                      // '' = すべての月
  const [sales, setSales] = useState(saved.sales || '');
  const [cs, setCs] = useState(saved.cs || '');
  const [statuses, setStatuses] = useState(saved.statuses || STATUS_ORDER);
  const [keyword, setKeyword] = useState(saved.keyword || '');
  const [sort, setSort] = useState(saved.sort || { key: 'planned', dir: 'asc' });
  // 絞り込み欄の開閉：PCは最初から開く、スマホは表を広く見せるため最初は閉じる
  const [filtersOpen, setFiltersOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 600));

  useEffect(() => {
    api.getProjects().then(setProjects).catch(e => { setError(e.message); setProjects([]); });
  }, []);
  useEffect(() => {
    saveFilters({ groupBy, monthBasis, month, sales, cs, statuses, keyword, sort });
  }, [groupBy, monthBasis, month, sales, cs, statuses, keyword, sort]);

  const allRows = useMemo(() => (projects || []).map(toRow), [projects]);
  const monthKeyOf = (r) => {
    const ymd = monthBasis === 'created' ? r.createdYmd : r.plannedYmd;
    return ymd ? ymd.slice(0, 7) : UNDATED;
  };

  // 絞り込みの選択肢（実際の案件から作る）
  const monthOptions = useMemo(() => {
    const keys = [...new Set(allRows.map(monthKeyOf))];
    return keys.sort((a, b) => (a === UNDATED) - (b === UNDATED) || a.localeCompare(b));
  }, [allRows, monthBasis]);
  const salesOptions = useMemo(() => [...new Set(allRows.map(r => r.sales_rep).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja')), [allRows]);
  const csOptions = useMemo(() => [...new Set(allRows.flatMap(r => r.cs))].sort((a, b) => a.localeCompare(b, 'ja')), [allRows]);

  const rows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const col = COLUMNS.find(c => c.key === sort.key) || COLUMNS[7];
    return allRows
      .filter(r => statuses.includes(r.status))
      .filter(r => !month || monthKeyOf(r) === month)
      .filter(r => !sales || r.sales_rep === sales || r.requested_by === sales)
      .filter(r => !cs || r.cs.includes(cs))
      .filter(r => !kw || [r.case_id, r.client_name, r.memo, r.project_type].some(v => v.toLowerCase().includes(kw)))
      .sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ja');
        return sort.dir === 'asc' ? c : -c;
      });
  }, [allRows, statuses, month, sales, cs, keyword, sort, monthBasis]);

  // まとめ表示（グループごとの見出しと件数）
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '', label: '', rows }];
    const map = new Map();
    const push = (k, r) => { if (!map.has(k)) map.set(k, []); map.get(k).push(r); };
    for (const r of rows) {
      if (groupBy === 'month') push(monthKeyOf(r), r);
      if (groupBy === 'sales') push(r.sales_rep || '（未設定）', r);
      if (groupBy === 'cs') {
        // 複数CSの案件は各人のグループに表示。CS担当で絞り込み中は、その人のグループだけにする
        const names = r.cs.length ? r.cs : ['（CS未割当）'];
        names.filter(n => !cs || n === cs).forEach(n => push(n, r));
      }
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (groupBy === 'month') return (a === UNDATED) - (b === UNDATED) || a.localeCompare(b);
      const unset = (k) => k.startsWith('（');
      return unset(a) - unset(b) || a.localeCompare(b, 'ja');
    });
    return keys.map(k => ({ key: k, label: groupBy === 'month' ? monthLabel(k) : k, rows: map.get(k) }));
  }, [rows, groupBy, monthBasis, cs]);

  const toggleStatus = (s) => setStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : STATUS_ORDER.filter(x => prev.includes(x) || x === s));
  const clickSort = (key) => setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' });
  const resetFilters = () => { setGroupBy('none'); setMonth(''); setSales(''); setCs(''); setStatuses(STATUS_ORDER); setKeyword(''); setSort({ key: 'planned', dir: 'asc' }); };

  const handleCsv = () => {
    if (!rows.length) { addToast('出力する案件がありません', 'error'); return; }
    const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/-/g, '');
    const parts = ['案件一覧', month ? monthLabel(month) : '', sales || '', cs ? `CS_${cs}` : '', d].filter(Boolean);
    downloadCsv(rows, parts.join('_'));
  };

  const statusSummary = (list) => STATUS_ORDER
    .map(s => [s, list.filter(r => r.status === s).length]).filter(([, n]) => n)
    .map(([s, n]) => `${STATUS_MAP[s].label} ${n}`).join('・');

  if (!projects) return <div className="loading">読み込み中...</div>;

  return (
    <div className="list-page">
      <div className="page-title">📋 案件一覧</div>

      {/* ── 絞り込み・表示切替（開閉式） ── */}
      <button type="button" className="btn btn-ghost btn-sm list-filter-toggle" onClick={() => setFiltersOpen(o => !o)} aria-expanded={filtersOpen}>
        🔍 絞り込み・表示切替 {filtersOpen ? '▲' : '▼'}
        <span className="list-filter-summary">{[
          groupBy !== 'none' && { month: '月ごと', sales: '担当営業ごと', cs: 'CS担当ごと' }[groupBy],
          month && monthLabel(month),
          sales && `営業：${sales}`,
          cs && `CS：${cs}`,
          statuses.length < STATUS_ORDER.length && `ステータス${statuses.length}種`,
          keyword && `「${keyword}」`,
        ].filter(Boolean).join('／') || '条件なし'}</span>
      </button>
      {filtersOpen && (
      <div className="card list-filters">
        <div className="list-filter-row">
          <label className="list-field">
            <span>まとめ表示</span>
            <select value={groupBy} onChange={e => setGroupBy(e.target.value)} aria-label="まとめ表示">
              <option value="none">まとめない（一覧）</option>
              <option value="month">月ごと</option>
              <option value="sales">担当営業ごと</option>
              <option value="cs">CS担当ごと</option>
            </select>
          </label>
          <label className="list-field">
            <span>月</span>
            <select value={month} onChange={e => setMonth(e.target.value)} aria-label="月">
              <option value="">すべての月</option>
              {monthOptions.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
            </select>
          </label>
          <label className="list-field">
            <span>月の基準</span>
            <select value={monthBasis} onChange={e => { setMonthBasis(e.target.value); setMonth(''); }} aria-label="月の基準">
              <option value="planned">予定日（確定日・候補日）</option>
              <option value="created">登録日</option>
            </select>
          </label>
          <label className="list-field">
            <span>担当営業</span>
            <select value={sales} onChange={e => setSales(e.target.value)} aria-label="担当営業">
              <option value="">全員</option>
              {salesOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="list-field">
            <span>CS担当</span>
            <select value={cs} onChange={e => setCs(e.target.value)} aria-label="CS担当">
              <option value="">全員</option>
              {csOptions.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="list-field list-field-wide">
            <span>キーワード</span>
            <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="顧客名・案件ID・備考で検索" aria-label="キーワード" />
          </label>
        </div>
        <div className="list-filter-row" style={{ alignItems: 'center' }}>
          {STATUS_ORDER.map(s => (
            <button key={s} type="button" onClick={() => toggleStatus(s)}
              className={`filter-chip ${statuses.includes(s) ? 'active' : ''}`} aria-pressed={statuses.includes(s)}>
              {STATUS_MAP[s].label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={resetFilters}>条件をリセット</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleCsv}>⬇ Excel用（CSV）</button>
        </div>
      </div>
      )}

      <div className="list-count">
        {error ? <span style={{ color: 'var(--danger)' }}>{error}</span>
          : <>表示中 <b>{rows.length}</b> 件 ／ 全 {allRows.length} 件{rows.length ? `（${statusSummary(rows)}）` : ''}</>}
      </div>

      {/* ── 表 ── */}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {COLUMNS.map(c => (
                <th key={c.key} onClick={() => clickSort(c.key)} className={c.key === 'case_id' ? 'sticky-col' : ''}
                  aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr><td colSpan={COLUMNS.length} className="empty-cell">条件に合う案件はありません</td></tr>
            )}
            {groups.map(g => [
              g.label && (
                <tr key={`g-${g.key}`} className="group-row">
                  <td colSpan={COLUMNS.length}>
                    <span className="group-title">{g.label}</span>
                    <span className="group-count">{g.rows.length}件（{statusSummary(g.rows)}）</span>
                  </td>
                </tr>
              ),
              ...g.rows.map(r => (
                <tr key={`${g.key}-${r.id}`} className="data-row" onClick={() => onNavigate('detail', r.id)} title="クリックで案件の詳細を開く">
                  <td className="sticky-col mono">{r.case_id || '—'}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="strong">{r.client_name}</td>
                  <td>{r.project_type}</td>
                  <td>{r.sales_rep}</td>
                  <td>{r.requested_by || <span className="muted">—</span>}</td>
                  <td>{r.delivery}</td>
                  <td className={r.plannedText ? '' : 'muted'}>{r.plannedText || '未定'}</td>
                  <td>{r.cs.length ? r.cs.join('、') : <span className="muted">—</span>}</td>
                  <td className="center">{r.days}</td>
                  <td className="memo-cell">{r.memo}</td>
                  <td onClick={e => e.stopPropagation()}>
                    {r.urls.length ? r.urls.map((u, i) => (
                      <div key={i}><a href={u.url} target="_blank" rel="noopener noreferrer">{u.label || 'リンク'}</a></div>
                    )) : <span className="muted">—</span>}
                  </td>
                  <td className="mono">{r.createdYmd}</td>
                  <td className="mono">{r.updatedYmd}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <div className="list-hint">行をクリックすると案件の詳細が開きます。列の見出しをクリックすると並べ替えできます。スマホでは表を左右にスクロールできます。</div>
    </div>
  );
}
