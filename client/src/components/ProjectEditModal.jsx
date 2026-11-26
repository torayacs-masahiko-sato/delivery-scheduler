// 管理者用「案件情報を編集」画面（全ステータス対応・キャンセル済みを除く）
// 入力 → 変更内容の確認 → 保存 の2段階。誤操作で案件情報を書き換えないよう、変更前後を見比べてから保存する。
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import StaffPicker from './StaffPicker';
import { PROJECT_TYPES, DELIVERY_LABELS, MEMO_MAX } from '../constants';

// 確定日時（"YYYY-MM-DD HH:MM" または "YYYY-MM-DD"）を日付と時刻に分ける
function splitConfirmed(value) {
  const m = String(value || '').match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return { date: m ? m[1] : '', time: m && m[2] ? m[2] : '' };
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflowY: 'auto' };
const panel = { background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)', border: '1px solid var(--glass-border)', borderRadius: 20, padding: 24, width: '100%', maxWidth: 460, maxHeight: '92vh', overflowY: 'auto' };

export default function ProjectEditModal({ project, onClose, onSaved, addToast }) {
  const isConfirmed = project.status === 'confirmed';
  const canEditDays = ['pending', 'scheduled'].includes(project.status);
  const candidateCount = (project.candidates || []).length;
  const initialTypes = String(project.project_type || '').split('・').map(t => t.trim()).filter(Boolean);
  const initialConfirmed = splitConfirmed(project.confirmed_date);

  const [form, setForm] = useState({
    client_name: project.client_name || '',
    project_type: initialTypes,
    sales_rep: project.sales_rep || '',
    delivery_method: project.delivery_method || 'remote',
    candidate_days: project.candidate_days || 1,
    memo: project.memo || '',
    confirmed_date: initialConfirmed.date,
    confirmed_time: initialConfirmed.time,
  });
  const [notify, setNotify] = useState(true);
  const [step, setStep] = useState('input'); // input | confirm
  const [salesUsers, setSalesUsers] = useState([]);
  const [showSalesPicker, setShowSalesPicker] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.getUsers().then(setSalesUsers).catch(() => {}); }, []);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // 選択肢：標準の案件内容 ＋ 以前の版で登録された一覧にない案件内容（消えないように残す）
  const typeOptions = [...PROJECT_TYPES, ...initialTypes.filter(t => !PROJECT_TYPES.includes(t))];
  const toggleType = (t) => set('project_type', form.project_type.includes(t)
    ? form.project_type.filter(x => x !== t)
    : typeOptions.filter(x => form.project_type.includes(x) || x === t));

  // 変更された項目の一覧（確認画面と保存に使う）
  const joinedTypes = form.project_type.join('・');
  const newConfirmed = form.confirmed_time ? `${form.confirmed_date} ${form.confirmed_time}` : form.confirmed_date;
  const oldConfirmed = initialConfirmed.time ? `${initialConfirmed.date} ${initialConfirmed.time}` : initialConfirmed.date;
  const changes = [
    ['顧客名', project.client_name, form.client_name.trim(), 'client_name'],
    ['案件内容', project.project_type, joinedTypes, 'project_type'],
    ['担当営業', project.sales_rep, form.sales_rep, 'sales_rep'],
    ['納品方法', DELIVERY_LABELS[project.delivery_method] || project.delivery_method, DELIVERY_LABELS[form.delivery_method], 'delivery_method'],
    ...(canEditDays ? [['希望候補日数', `${project.candidate_days || 1}日`, `${form.candidate_days}日`, 'candidate_days']] : []),
    ['備考', project.memo, form.memo.trim(), 'memo'],
    ...(isConfirmed ? [['確定日時', oldConfirmed, newConfirmed, 'confirmed_date']] : []),
  ].filter(([, before, after]) => String(before ?? '') !== String(after ?? ''));
  const dateChanged = changes.some(c => c[3] === 'confirmed_date');

  const validate = () => {
    if (!form.client_name.trim()) return '顧客名を入力してください';
    if (!form.project_type.length) return '案件内容を1つ以上選択してください';
    if (!form.sales_rep) return '担当営業を選択してください';
    if (!form.memo.trim()) return '備考を入力してください';
    if (form.memo.trim().length > MEMO_MAX) return `備考は${MEMO_MAX}文字以内で入力してください`;
    if (canEditDays && form.candidate_days < candidateCount) return `希望候補日数は登録済みの候補日（${candidateCount}件）以上にしてください`;
    if (isConfirmed && !form.confirmed_date) return '確定日を入力してください';
    return null;
  };

  const goConfirm = () => {
    const err = validate();
    if (err) { addToast(err, 'error'); return; }
    if (!changes.length) { addToast('変更された項目がありません', 'error'); return; }
    setStep('confirm');
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      let updated = null;
      const patch = {};
      for (const [, , , key] of changes) {
        if (key === 'confirmed_date') continue;
        if (key === 'client_name') patch.client_name = form.client_name.trim();
        if (key === 'project_type') patch.project_type = joinedTypes;
        if (key === 'sales_rep') patch.sales_rep = form.sales_rep;
        if (key === 'delivery_method') patch.delivery_method = form.delivery_method;
        if (key === 'candidate_days') patch.candidate_days = Number(form.candidate_days);
        if (key === 'memo') patch.memo = form.memo.trim();
      }
      if (Object.keys(patch).length) updated = await api.updateProject(project.id, patch);
      if (dateChanged) {
        updated = await api.updateConfirmedDate(project.id, { date: form.confirmed_date, time: form.confirmed_time, notify });
      }
      addToast(dateChanged && notify ? '案件情報を更新し、日程変更を通知しました' : '案件情報を更新しました');
      onSaved(updated);
    } catch (err) {
      addToast(err.message, 'error');
      setStep('input'); // 失敗時は入力画面に戻る（入力内容は残る）
    } finally { setSaving(false); }
  };

  // ── 確認画面 ──
  if (step === 'confirm') {
    return (
      <div style={overlay}>
        <div style={panel}>
          <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 4 }}>変更内容の確認</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-sub)', marginBottom: 12 }}>{project.case_id} ／ {project.client_name}</div>
          {changes.map(([label, before, after]) => (
            <div key={label} className="card" style={{ marginBottom: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', textDecoration: 'line-through', wordBreak: 'break-all' }}>{before || '（未設定）'}</div>
              <div style={{ fontSize: '0.92rem', fontWeight: 600, wordBreak: 'break-all' }}>→ {after || '（未設定）'}</div>
            </div>
          ))}
          {dateChanged && (
            <div style={{ fontSize: '0.78rem', margin: '6px 0 12px', color: notify ? 'var(--text)' : 'var(--warning)' }}>
              {notify ? '※ 担当営業・CS担当者に日程変更の通知メールを送信します' : '※ 日程変更の通知メールは送信しません（関係者へ別途ご連絡ください）'}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-ghost" style={{ flex: 1, whiteSpace: 'nowrap' }} onClick={() => setStep('input')} disabled={saving}>← 修正する</button>
            <button type="button" className="btn btn-primary" style={{ flex: 2 }} onClick={save} disabled={saving}>{saving ? '保存中...' : 'この内容で保存する'}</button>
          </div>
        </div>
      </div>
    );
  }

  // ── 入力画面 ──
  return (
    <div style={overlay}>
      <div style={panel}>
        <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 12 }}>✏️ 案件情報を編集</div>

        <div className="form-group">
          <label>顧客名 *</label>
          <input value={form.client_name} maxLength={100} onChange={e => set('client_name', e.target.value)} />
        </div>

        <div className="form-group">
          <label>案件内容 *（複数選択可）</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {typeOptions.map(t => (
              <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
                border: `1px solid ${form.project_type.includes(t) ? 'var(--accent)' : 'var(--border)'}`,
                background: form.project_type.includes(t) ? 'rgba(59,130,246,0.12)' : 'transparent' }}>
                <input type="checkbox" checked={form.project_type.includes(t)} onChange={() => toggleType(t)} style={{ width: 'auto', margin: 0 }} />
                {t}
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>担当営業 *</label>
          <button type="button" className="btn btn-ghost btn-full" style={{ justifyContent: 'space-between' }} onClick={() => setShowSalesPicker(true)}>
            <span>{form.sales_rep || '担当営業を選択'}</span><span>▾</span>
          </button>
          {/* ぼかし効果のあるパネルの内側だと選択画面が全画面にならないため、画面全体（body直下）に表示 */}
          {showSalesPicker && createPortal(
            <StaffPicker title="担当営業を選択" members={salesUsers}
              value={form.sales_rep ? [form.sales_rep] : []}
              onChange={(names) => set('sales_rep', names[0] || '')}
              onClose={() => setShowSalesPicker(false)} multi={false} addToast={addToast} />,
            document.body
          )}
          {project.requested_by && project.requested_by !== form.sales_rep && (
            <div style={{ fontSize: '0.72rem', color: 'var(--text-sub)', marginTop: 4 }}>依頼した営業（{project.requested_by}）も引き続きこの案件を確認できます</div>
          )}
        </div>

        <div className="form-group">
          <label>納品方法</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {Object.entries(DELIVERY_LABELS).map(([v, l]) => (
              <label key={v} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.88rem', cursor: 'pointer', padding: '8px 10px', borderRadius: 8,
                border: `1px solid ${form.delivery_method === v ? 'var(--accent)' : 'var(--border)'}` }}>
                <input type="radio" name="edit_delivery" checked={form.delivery_method === v} onChange={() => set('delivery_method', v)} style={{ width: 'auto', margin: 0 }} />
                {l}
              </label>
            ))}
          </div>
        </div>

        {canEditDays && (
          <div className="form-group">
            <label>希望候補日数</label>
            <select value={form.candidate_days} onChange={e => set('candidate_days', Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map(n => (
                <option key={n} value={n} disabled={n < candidateCount}>{n}日{n < candidateCount ? '（登録済み候補日より少ないため不可）' : ''}</option>
              ))}
            </select>
          </div>
        )}

        <div className="form-group">
          <label>備考 *（{MEMO_MAX}文字以内）</label>
          <input value={form.memo} maxLength={MEMO_MAX} onChange={e => set('memo', e.target.value)} />
          <div style={{ fontSize: '0.7rem', color: 'var(--text-sub)', textAlign: 'right' }}>{form.memo.length}/{MEMO_MAX}</div>
        </div>

        {isConfirmed && (
          <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <label>確定日時</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="date" value={form.confirmed_date} onChange={e => set('confirmed_date', e.target.value)} style={{ flex: 3 }} />
              <input type="time" value={form.confirmed_time} onChange={e => set('confirmed_time', e.target.value)} style={{ flex: 2 }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', marginTop: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={notify} onChange={e => setNotify(e.target.checked)} style={{ width: 'auto', margin: 0 }} />
              日時を変更した場合、担当営業・CS担当者に通知メールを送る
            </label>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-sub)', marginTop: 4 }}>CS担当者の変更は、確定日の欄の「CS担当者を変更」から行えます</div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" className="btn btn-ghost" style={{ flex: 1, whiteSpace: 'nowrap' }} onClick={onClose}>キャンセル</button>
          <button type="button" className="btn btn-primary" style={{ flex: 2 }} onClick={goConfirm}>変更内容を確認</button>
        </div>
      </div>
    </div>
  );
}
