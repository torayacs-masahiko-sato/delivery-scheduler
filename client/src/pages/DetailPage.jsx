import { useState, useEffect } from 'react';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { StatusBadge, formatDate, formatDateTime, STATUS_MAP } from '../components/StatusBadge';
import StaffPicker from '../components/StaffPicker';

const DELIVERY_LABELS = { remote: '🖥 リモート', onsite: '🚗 現地訪問' };

export default function DetailPage({ projectId, onBack, addToast, onRefresh }) {
  const { user } = useAuth();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [salesUsers, setSalesUsers] = useState([]);
  const [csMembers, setCsMembers] = useState([]);

  // 候補日追加・編集フォーム
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingCandidateId, setEditingCandidateId] = useState(null); // null=新規追加, id=編集中
  const [newCandidate, setNewCandidate] = useState({ date: '', date_to: '', time: '', cs_members: [], sales_rep: '' });
  const [conflicts, setConflicts] = useState(null);
  const [showCandidateCsPicker, setShowCandidateCsPicker] = useState(false);
  const [showCandidateSalesPicker, setShowCandidateSalesPicker] = useState(false);

  // 確定モーダル（CS部員選択）
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [selectedCs, setSelectedCs] = useState([]);

  // 設定完了モーダル（不足理由入力）
  const [showFinalizeModal, setShowFinalizeModal] = useState(false);
  const [shortageReason, setShortageReason] = useState('');

  // キャンセルモーダル
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  // 確定済み案件のCS担当者変更（管理者専用）
  const [showEditCsPicker, setShowEditCsPicker] = useState(false);
  const [editingCs, setEditingCs] = useState(false);

  // 案件ごとのメッセージ（営業⇔管理者）
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messageInput, setMessageInput] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);

  const loadMessages = () => {
    setMessagesLoading(true);
    api.getMessages(projectId).then(setMessages).catch(() => {}).finally(() => setMessagesLoading(false));
  };

  const load = () => {
    setLoading(true);
    api.getProject(projectId).then(p => {
      setProject(p);
      setSelectedCs(p.cs_members || []);
    }).finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    loadMessages();
    api.getUsers().then(setSalesUsers).catch(() => {});
    api.getCsMembers().then(setCsMembers).catch(() => {});
  }, [projectId]);

  const projectArea = (() => {
    if (!project) return null;
    const u = salesUsers.find(u => u.display_name === project.sales_rep);
    return u?.area || '東京';
  })();

  // 営業用：CS選択なしで直接確定（確定した候補日固有のCS担当者を引き継ぐ）
  const handleConfirmDirect = async (candidate) => {
    const dateStr = formatCandDate(candidate);
    if (!confirm(`「${dateStr}」でスケジュールを確定しますか？`)) return;
    setBusy(true);
    try {
      const updated = await api.confirmSchedule(projectId, {
        confirmed_date: candidate.candidate_date,
        confirmed_time: candidate.candidate_time,
        cs_members: candidate.cs_members || [],   // ★ その候補日固有のCS担当者のみを引き継ぐ
        sales_rep: candidate.sales_rep || project.sales_rep,
        shortage_reason: project.shortage_reason || '',
      });
      setProject(updated);
      addToast('スケジュールを確定しました！');
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 管理者用：CS選択モーダルを開く（その候補日固有のCS担当者を初期表示）
  const openConfirmModal = (candidate) => {
    setConfirmTarget(candidate);
    setSelectedCs(candidate.cs_members || []);
    setShortageReason('');
    setShowConfirmModal(true);
  };

  // 仮スケジュール確定（CS部員選択のみ・不足理由は設定完了時に入力済み）
  const handleConfirmSchedule = async () => {
    if (!confirmTarget) return;
    if (selectedCs.length > 2) { addToast('CS部員は最大2名まで選択できます', 'error'); return; }
    setBusy(true);
    try {
      const updated = await api.confirmSchedule(projectId, {
        confirmed_date: confirmTarget.candidate_date,
        confirmed_time: confirmTarget.candidate_time,
        cs_members: selectedCs,
        sales_rep: confirmTarget.sales_rep || project.sales_rep,
        shortage_reason: project.shortage_reason || '',
      });
      setProject(updated);
      setShowConfirmModal(false);
      addToast('スケジュールを確定しました！');
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  const toggleCs = (name) => {
    setSelectedCs(prev =>
      prev.includes(name) ? prev.filter(n => n !== name)
        : prev.length >= 2 ? (addToast('CS部員は最大2名まで選択できます', 'error'), prev)
        : [...prev, name]
    );
  };

  const handleCancel = async () => {
    if (!cancelReason.trim()) { addToast('キャンセル理由を入力してください', 'error'); return; }
    setBusy(true);
    try {
      const updated = await api.cancelProject(projectId, { reason: cancelReason });
      setProject(updated);
      addToast('案件をキャンセルしました');
      setShowCancelModal(false);
      setCancelReason('');
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleRemind = async () => {
    if (!confirm('CS部管理者と自身にリマインドメールを送信しますか？')) return;
    setBusy(true);
    try {
      await api.sendReminder(projectId, user.login_id);
      addToast('リマインドメールを送信しました');
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 仮スケ設定済みの案件について、管理者から営業担当へ日程確定の催促メールを送信
  const handleRemindConfirm = async () => {
    if (!confirm(`${project.sales_rep}さんへ日程確定の催促メールを送信しますか？`)) return;
    setBusy(true);
    try {
      await api.sendConfirmReminder(projectId);
      addToast('催促メールを送信しました');
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 確定済み案件のCS担当者を変更（管理者専用・変更通知メール送信）
  const handleUpdateConfirmedCs = async (names) => {
    if (!names.length) { addToast('CS担当者を1名以上選択してください', 'error'); return; }
    setEditingCs(true);
    try {
      const updated = await api.updateConfirmedCsMembers(projectId, names);
      setProject(p => ({ ...p, ...updated }));
      addToast('CS担当者を変更し、変更通知メールを送信しました');
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setEditingCs(false); }
  };

  const checkConflict = async (date, time) => {
    if (!date) { setConflicts(null); return; }
    const result = await api.getConflicts(date, time, projectId, projectArea).catch(() => null);
    setConflicts(result);
  };

  // 候補日の編集を開始（フォームに既存の値をセット）
  const handleEditCandidateStart = (candidate) => {
    setEditingCandidateId(candidate.id);
    setNewCandidate({
      date: candidate.candidate_date,
      date_to: candidate.candidate_date_to || '',
      time: candidate.candidate_time || '',
      cs_members: candidate.cs_members || [],
      sales_rep: candidate.sales_rep || project.sales_rep || '',
    });
    setConflicts(null);
    setShowAddForm(true);
  };

  const handleCancelEdit = () => {
    setEditingCandidateId(null);
    setNewCandidate({ date: '', date_to: '', time: '', cs_members: [], sales_rep: project?.sales_rep || '' });
    setConflicts(null);
    setShowAddForm(false);
  };

  const handleAddCandidate = async (e) => {
    e.preventDefault();
    if (conflicts?.blocked || conflicts?.sales_reps?.length >= 2) { addToast('この日程は登録できません', 'error'); return; }
    if (!(newCandidate.cs_members || []).length) { addToast('CS担当者を1名以上選択してください', 'error'); return; }

    // 編集モードでなければ希望日数の上限チェック
    if (!editingCandidateId) {
      const maxDays = project.candidate_days || 1;
      if ((project.candidates?.length || 0) >= maxDays) {
        addToast(`希望候補日数（${maxDays}日）を超えて登録することはできません`, 'error'); return;
      }
    }

    setBusy(true);
    try {
      let updatedCands;
      if (editingCandidateId) {
        updatedCands = await api.updateCandidate(projectId, editingCandidateId, newCandidate);
        addToast('候補日を修正しました');
      } else {
        updatedCands = await api.addCandidate(projectId, newCandidate);
        addToast('候補日を追加しました');
      }
      setProject(p => ({ ...p, candidates: updatedCands }));
      setNewCandidate({ date: '', date_to: '', time: '', cs_members: [] });
      setEditingCandidateId(null);
      setConflicts(null);
      setShowAddForm(false);
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleDeleteCandidate = async (candidateId) => {
    if (!confirm('この候補日を削除しますか？')) return;
    setBusy(true);
    try {
      const updatedCands = await api.deleteCandidate(projectId, candidateId);
      setProject(p => ({ ...p, candidates: updatedCands }));
      addToast('候補日を削除しました');
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 設定完了ボタン押下 → 不足チェック → 必要なら理由入力モーダル → API呼び出し
  const handleFinalizeCandidates = () => {
    const maxDays = project.candidate_days || 1;
    const currentCount = project.candidates?.length || 0;
    if (currentCount > maxDays) { addToast(`希望候補日数（${maxDays}日）を超えています。${currentCount - maxDays}件削除してください`, 'error'); return; }
    if (currentCount === 0) { addToast('候補日を1件以上登録してください', 'error'); return; }
    // CS担当者必須チェック（すべての候補日に1名以上設定されているか）
    const missingCs = (project.candidates || []).some(c => !(c.cs_members || []).length);
    if (missingCs) { addToast('すべての候補日にCS担当者を1名以上設定してください', 'error'); return; }
    // 不足の場合はモーダルで理由入力 / ちょうどの場合は即確認
    if (currentCount < maxDays) {
      setShortageReason('');
      setShowFinalizeModal(true);
    } else {
      doFinalize('');
    }
  };

  const doFinalize = async (reason) => {
    setBusy(true);
    try {
      // shortage_reason を保存（cs_membersは各候補日の設定がfinalize時にサーバー側で自動集約される）
      if (reason) {
        await api.updateProject(projectId, { shortage_reason: reason });
      }
      const updated = await api.finalizeCandidates(projectId);
      setProject(updated);
      setShowFinalizeModal(false);
      setShortageReason('');
      addToast('候補日の設定が完了し、通知メールを送信しました');
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  const handleStatusChange = async (newStatus) => {
    setBusy(true);
    try {
      const updated = await api.updateProject(projectId, { status: newStatus });
      setProject(updated);
      addToast(`ステータスを「${STATUS_MAP[newStatus]?.label}」に変更しました`);
      onRefresh();
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 希望候補日数の上限に達していても、管理者が候補日を追加できるよう上限を1件増やす
  const handleIncreaseMaxDays = async () => {
    const maxDays = project.candidate_days || 1;
    setBusy(true);
    try {
      const updated = await api.updateProject(projectId, { candidate_days: maxDays + 1 });
      setProject(p => ({ ...p, ...updated, candidates: p.candidates }));
      addToast(`候補日の上限を${maxDays + 1}日に増やしました`);
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 顧客情報URLの登録・編集（管理者・担当営業）
  const handleEditClientUrl = async () => {
    const next = window.prompt('顧客情報のURLを入力してください（空にすると削除されます）', project.client_url || '');
    if (next === null) return; // キャンセル
    const trimmed = next.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      addToast('URLは http:// または https:// から入力してください', 'error'); return;
    }
    setBusy(true);
    try {
      const updated = await api.updateProject(projectId, { client_url: trimmed });
      setProject(p => ({ ...p, ...updated, candidates: p.candidates }));
      addToast(trimmed ? '顧客情報URLを更新しました' : '顧客情報URLを削除しました');
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 備考の編集（担当営業・管理者）
  const handleEditMemo = async () => {
    const next = window.prompt('備考を入力してください（50文字以内・必須）', project.memo || '');
    if (next === null) return; // キャンセル
    const trimmed = next.trim();
    if (!trimmed) { addToast('備考は必須です。空にはできません', 'error'); return; }
    if (trimmed.length > 50) { addToast('備考は50文字以内で入力してください', 'error'); return; }
    setBusy(true);
    try {
      const updated = await api.updateProject(projectId, { memo: trimmed });
      setProject(p => ({ ...p, ...updated, candidates: p.candidates }));
      addToast('備考を更新しました');
    } catch (err) { addToast(err.message, 'error'); }
    finally { setBusy(false); }
  };

  // 案件ごとのメッセージ送信（営業⇔管理者）
  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!messageInput.trim()) return;
    setSendingMessage(true);
    try {
      const created = await api.sendMessage(projectId, {
        body: messageInput.trim(),
        sender_name: user.name,
        sender_role: isAdmin ? 'admin' : 'sales',
        sender_login_id: user.login_id,
      });
      setMessages(m => [...m, created]);
      setMessageInput('');
    } catch (err) { addToast(err.message, 'error'); }
    finally { setSendingMessage(false); }
  };

  const handleDelete = async () => {
    if (!confirm('この案件を削除しますか？')) return;
    await api.deleteProject(projectId);
    addToast('案件を削除しました');
    onRefresh(); onBack();
  };

  if (loading) return <div className="empty-state">読み込み中...</div>;
  if (!project) return <div className="empty-state">案件が見つかりません</div>;

  const isAdmin = user.role === 'admin';
  const isOwner = project.sales_rep === user.name;
  const isCancelled = project.status === 'cancelled';
  const isConfirmed = project.status === 'confirmed';
  const isDelivered = project.status === 'delivered';
  const isPending = project.status === 'pending';
  const isScheduled = project.status === 'scheduled';

  const canEditCandidates = isAdmin && !isCancelled && !isDelivered && !isConfirmed;
  const hasAnyCandidates = (project.candidates?.length || 0) > 0;
  const canConfirm = hasAnyCandidates && (isOwner || isAdmin) && !isCancelled && !isConfirmed && !isDelivered;
  // リマインドは営業担当が管理者へ候補日設定を促すための機能なので、営業（担当者）のみ
  const canRemind = isPending && isOwner && !isAdmin;
  // 仮スケ設定済みの案件について、管理者が営業担当へ日程確定を催促できる
  const canRemindConfirm = isScheduled && isAdmin && hasAnyCandidates;
  const canCancel = !isCancelled && !isDelivered;

  const cands = project.candidates || [];
  const maxDays = project.candidate_days || 1;
  const candidatesReady = cands.length === maxDays;
  const candidatesShort = cands.length < maxDays;
  const candidatesOver = cands.length > maxDays;

  const formatCandDate = (c) => {
    let s = formatDate(c.candidate_date);
    if (c.candidate_date_to) s += `〜${formatDate(c.candidate_date_to)}`;
    if (c.candidate_time) s += ` ${c.candidate_time}`;
    return s;
  };

  return (
    <>
      {/* 確定モーダル（管理者用・CS部員は設定完了時に選択済み） */}
      {showConfirmModal && confirmTarget && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}>
          <div style={{ background:'var(--glass-bg)',backdropFilter:'var(--glass-blur)',WebkitBackdropFilter:'var(--glass-blur)',border:'1px solid var(--glass-border)',borderRadius:20,padding:24,width:'100%',maxWidth:400 }}>
            <div style={{ fontWeight:700,fontSize:'1.1rem',marginBottom:16 }}>📅 スケジュールを確定</div>

            <div style={{ padding:'10px 12px',background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.25)',borderRadius:8,marginBottom:16 }}>
              <div style={{ fontSize:'0.72rem',color:'var(--success)',marginBottom:2 }}>確定日</div>
              <div style={{ fontWeight:600,color:'var(--success)',fontSize:'1rem' }}>
                {formatCandDate(confirmTarget)}
              </div>
              {confirmTarget.sales_rep && (
                <div style={{ fontSize:'0.8rem',color:'var(--success)',marginTop:4 }}>
                  👤 担当営業：{confirmTarget.sales_rep}
                </div>
              )}
            </div>

            {/* CS部員の確認表示（この候補日に設定済みのCS担当者） */}
            {(confirmTarget.cs_members || []).length > 0 && (
              <div style={{ padding:'8px 12px',background:'rgba(59,130,246,0.07)',border:'1px solid rgba(59,130,246,0.2)',borderRadius:8,marginBottom:16,fontSize:'0.82rem' }}>
                <div style={{ fontSize:'0.7rem',color:'var(--text-sub)',marginBottom:4 }}>この日程のCS担当者</div>
                {(confirmTarget.cs_members || []).map(name => (
                  <div key={name} style={{ color:'var(--accent-lt)' }}>✓ {name}</div>
                ))}
              </div>
            )}

            <div style={{ display:'flex',gap:8 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => setShowConfirmModal(false)}>キャンセル</button>
              <button className="btn btn-success" style={{ flex:1 }} onClick={handleConfirmSchedule} disabled={busy}>
                {busy ? '確定中...' : '確定する'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 設定完了モーダル（候補日不足時の理由入力） */}
      {showFinalizeModal && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}>
          <div style={{ background:'var(--glass-bg)',backdropFilter:'var(--glass-blur)',WebkitBackdropFilter:'var(--glass-blur)',border:'1px solid var(--glass-border)',borderRadius:20,padding:24,width:'100%',maxWidth:400 }}>
            <div style={{ fontWeight:700,fontSize:'1.1rem',marginBottom:8,color:'var(--warning)' }}>
              ⚠️ 候補日が希望日数より少ない状態で設定完了します
            </div>
            <div style={{ fontSize:'0.82rem',color:'var(--text-sub)',marginBottom:16,lineHeight:1.6 }}>
              希望候補日数：{project?.candidate_days || 1}日 ／ 現在の候補日：{project?.candidates?.length || 0}件<br />
              やむを得ない理由がある場合は、以下に理由を入力して設定完了できます。
            </div>
            <div className="form-group">
              <label>不足理由 *</label>
              <textarea
                value={shortageReason}
                onChange={e => setShortageReason(e.target.value)}
                placeholder="希望日数を満たせなかった理由を入力してください"
                style={{ minHeight:80 }}
                autoFocus
              />
            </div>
            <div style={{ display:'flex',gap:8 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setShowFinalizeModal(false); setShortageReason(''); }}>
                キャンセル
              </button>
              <button className="btn btn-warning" style={{ flex:1, background:'var(--warning)', color:'#fff' }}
                onClick={() => { if (!shortageReason.trim()) { alert('不足理由を入力してください'); return; } doFinalize(shortageReason); }}
                disabled={busy}>
                {busy ? '処理中...' : '理由を入力して設定完了'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* キャンセルモーダル */}
      {showCancelModal && (
        <div style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.7)',zIndex:300,display:'flex',alignItems:'center',justifyContent:'center',padding:16 }}>
          <div style={{ background:'var(--glass-bg)',backdropFilter:'var(--glass-blur)',WebkitBackdropFilter:'var(--glass-blur)',border:'1px solid var(--glass-border)',borderRadius:20,padding:24,width:'100%',maxWidth:380 }}>
            <div style={{ fontWeight:700,fontSize:'1.1rem',marginBottom:8,color:'var(--danger)' }}>⚠️ キャンセル確認</div>
            <div style={{ fontSize:'0.82rem',color:'var(--text-sub)',marginBottom:16,lineHeight:1.6 }}>
              キャンセルすると元に戻せません。<br />再スケジュールが必要な場合は新規案件として再申請してください。
            </div>
            <div className="form-group">
              <label>キャンセル理由 *</label>
              <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)}
                placeholder="キャンセルの理由を入力してください" style={{ minHeight:80 }} autoFocus />
            </div>
            <div style={{ display:'flex',gap:8 }}>
              <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setShowCancelModal(false); setCancelReason(''); }}>戻る</button>
              <button className="btn btn-danger" style={{ flex:1 }} onClick={handleCancel} disabled={busy||!cancelReason.trim()}>
                {busy ? '処理中...' : 'キャンセルする'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ヘッダー */}
      <div style={{ display:'flex',alignItems:'center',gap:12,marginBottom:20 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← 戻る</button>
        <StatusBadge status={project.status} />
      </div>
      <div className="page-title">{project.project_type || '—'}</div>
      <div className="page-sub">{project.client_name}</div>

      {/* 確定バナー */}
      {isConfirmed && project.confirmed_date && (
        <div className="confirmed-banner">
          <span style={{ fontSize:'1.2rem' }}>✅</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:'0.72rem',color:'var(--success)',marginBottom:2 }}>確定日</div>
            <div className="date-text">{formatDateTime(project.confirmed_date)}</div>
            {(project.cs_members||[]).length > 0 && (
              <div style={{ fontSize:'0.75rem',color:'var(--success)',marginTop:2 }}>CS担当：{project.cs_members.join('、')}</div>
            )}
            {isAdmin && (
              <div style={{ marginTop:8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setShowEditCsPicker(true)}
                  disabled={editingCs}
                  style={{ borderColor:'rgba(16,185,129,0.4)',color:'var(--success)' }}
                >
                  🛠 CS担当者を変更
                </button>
                {showEditCsPicker && (
                  <StaffPicker
                    title="CS担当者を変更（変更通知メールを送信します）"
                    members={csMembers}
                    value={project.cs_members || []}
                    onChange={handleUpdateConfirmedCs}
                    onClose={() => setShowEditCsPicker(false)}
                    multi={true}
                    max={2}
                    addToast={addToast}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* キャンセルバナー */}
      {isCancelled && (
        <div style={{ padding:'12px 14px',borderRadius:10,marginBottom:16,background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)' }}>
          <div style={{ fontSize:'0.72rem',color:'var(--danger)',marginBottom:4 }}>キャンセル済み</div>
          <div style={{ fontSize:'0.88rem' }}>理由：{project.cancel_reason || '—'}</div>
          <div style={{ fontSize:'0.75rem',color:'var(--text-sub)',marginTop:6 }}>再スケジュールが必要な場合は新規案件として再申請してください</div>
        </div>
      )}

      {/* メタ情報 */}
      <div className="detail-meta">
        {project.case_id && (
          <div className="meta-item" style={{ gridColumn: '1 / -1' }}>
            <div className="meta-label">案件ID</div>
            <div className="meta-value" style={{ fontFamily: 'monospace', letterSpacing: '0.04em' }}>
              {project.case_id}
            </div>
          </div>
        )}
        <div className="meta-item"><div className="meta-label">担当営業</div><div className="meta-value">{project.sales_rep}</div></div>
        <div className="meta-item"><div className="meta-label">納品方法</div><div className="meta-value">{DELIVERY_LABELS[project.delivery_method]||'—'}</div></div>
        <div className="meta-item"><div className="meta-label">ステータス</div><div className="meta-value">{STATUS_MAP[project.status]?.label??project.status}</div></div>
        <div className="meta-item"><div className="meta-label">希望候補日数</div><div className="meta-value">{maxDays}日</div></div>
        {(isOwner || isAdmin) && (
          <div className="meta-item" style={{ gridColumn:'1/-1' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div className="meta-label">顧客情報URL</div>
              <button className="btn btn-ghost btn-sm" onClick={handleEditClientUrl} disabled={busy} style={{ padding:'2px 8px', fontSize:'0.72rem' }}>
                {project.client_url ? '編集' : '+ 追加'}
              </button>
            </div>
            {project.client_url ? (
              <a href={project.client_url} target="_blank" rel="noopener noreferrer"
                className="meta-value" style={{ color:'var(--accent-lt)', wordBreak:'break-all', display:'block' }}>
                🔗 {project.client_url}
              </a>
            ) : (
              <div className="meta-value" style={{ color:'var(--text-sub)' }}>未登録</div>
            )}
          </div>
        )}
        {(project.cs_members||[]).length > 0 && (
          <div className="meta-item" style={{ gridColumn:'1/-1' }}>
            <div className="meta-label">CS担当者</div>
            <div className="meta-value">{project.cs_members.join('、')}</div>
          </div>
        )}
        {project.shortage_reason && (
          <div className="meta-item" style={{ gridColumn:'1/-1' }}>
            <div className="meta-label">不足理由</div>
            <div className="meta-value" style={{ color:'var(--warning)' }}>{project.shortage_reason}</div>
          </div>
        )}
        {project.confirmed_date && (
          <div className="meta-item" style={{ gridColumn:'1/-1' }}>
            <div className="meta-label">確定日時</div>
            <div className="meta-value">{formatDateTime(project.confirmed_date)}</div>
          </div>
        )}
        <div className="meta-item" style={{ gridColumn:'1/-1' }}>
          <div className="meta-label">最終更新</div>
          <div className="meta-value">{formatDateTime(project.updated_at)}</div>
        </div>
      </div>

      {(project.memo || isOwner || isAdmin) && (
        <div className="card">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: project.memo ? 8 : 0 }}>
            <div className="section-title" style={{ marginBottom:0 }}>備考</div>
            {(isOwner || isAdmin) && (
              <button className="btn btn-ghost btn-sm" onClick={handleEditMemo} disabled={busy} style={{ padding:'2px 8px', fontSize:'0.72rem' }}>
                {project.memo ? '編集' : '+ 追加'}
              </button>
            )}
          </div>
          {project.memo ? (
            <div style={{ fontSize:'0.9rem',lineHeight:1.6 }}>{project.memo}</div>
          ) : (isOwner || isAdmin) ? (
            <div style={{ fontSize:'0.85rem', color:'var(--text-sub)' }}>未登録</div>
          ) : null}
        </div>
      )}

      {/* 候補日セクション */}
      {!isCancelled && (
        <div className="card">
          <div style={{ display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12 }}>
            <div className="section-title" style={{ marginBottom:0 }}>{isConfirmed ? '確定スケジュール' : '候補日'}</div>
            <div style={{ display:'flex', gap:6 }}>
              {canEditCandidates && !editingCandidateId && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleIncreaseMaxDays}
                  disabled={busy}
                  title="希望候補日数を1日増やして、追加で候補日を登録できるようにします"
                >
                  🔧 候補日数+1
                </button>
              )}
              {canEditCandidates && cands.length < maxDays && !editingCandidateId && (
                <button className="btn btn-ghost btn-sm" onClick={() => {
                  setEditingCandidateId(null);
                  if (!showAddForm) setNewCandidate(c => ({ ...c, sales_rep: c.sales_rep || project.sales_rep || '' }));
                  setShowAddForm(v => !v);
                }}>
                  {showAddForm ? '閉じる' : '+ 追加'}
                </button>
              )}
            </div>
          </div>

          {/* 候補日追加フォーム */}
          {showAddForm && canEditCandidates && (
            <form onSubmit={handleAddCandidate} style={{ marginBottom:12,padding:12,background:'rgba(59,130,246,0.06)',borderRadius:8,border:'1px solid rgba(59,130,246,0.2)' }}>
              <div style={{ fontSize:'0.78rem',color:'var(--text-sub)',marginBottom:8 }}>
                {editingCandidateId
                  ? `候補日を修正（希望候補日数：${maxDays}日）`
                  : `第${cands.length+1}候補を追加（希望候補日数：${maxDays}日）`}
              </div>
              <div className="date-range-row" style={{ marginBottom:6 }}>
                <div className="date-range-field">
                  <div className="date-range-field-label"><span>開始日 *</span></div>
                  <input type="date" value={newCandidate.date}
                    onChange={e => { setNewCandidate(c => ({ ...c, date: e.target.value })); checkConflict(e.target.value, newCandidate.time); }} required />
                </div>
                <div className="date-range-field">
                  <div className="date-range-field-label">
                    <span>終了日（期間指定の場合）</span>
                    {newCandidate.date_to && (
                      <button type="button" className="date-range-clear-btn"
                        onClick={() => setNewCandidate(c => ({ ...c, date_to: '' }))}>
                        取消
                      </button>
                    )}
                  </div>
                  <input type="date" value={newCandidate.date_to}
                    onChange={e => setNewCandidate(c => ({ ...c, date_to: e.target.value }))}
                    min={newCandidate.date} />
                </div>
              </div>
              <div style={{ marginBottom:8 }}>
                <div style={{ fontSize:'0.72rem',color:'var(--text-sub)',marginBottom:4 }}>開始時刻（任意）</div>
                <input type="time" style={{ width:130 }} value={newCandidate.time}
                  onChange={e => { setNewCandidate(c => ({ ...c, time: e.target.value })); checkConflict(newCandidate.date, e.target.value); }} />
              </div>
              {/* 候補日ごとの営業メンバー選択（管理者のみ） */}
              {isAdmin && salesUsers.length > 0 && (
                <div className="form-group" style={{ marginBottom:8 }}>
                  <div style={{ fontSize:'0.72rem', color:'var(--text-sub)', marginBottom:6, fontWeight:600, textTransform:'none', letterSpacing:0 }}>
                    この候補日の営業メンバー
                  </div>
                  <button
                    type="button"
                    className={`picker-trigger${!newCandidate.sales_rep ? ' empty' : ''}`}
                    onClick={() => setShowCandidateSalesPicker(true)}
                  >
                    <span className="picker-trigger-chips">
                      {newCandidate.sales_rep
                        ? <span className="picker-trigger-chip">{newCandidate.sales_rep}</span>
                        : '営業メンバーを選択'}
                    </span>
                    <span className="picker-trigger-arrow">▼</span>
                  </button>
                  {showCandidateSalesPicker && (
                    <StaffPicker
                      title="この候補日の営業メンバー"
                      members={salesUsers}
                      value={newCandidate.sales_rep ? [newCandidate.sales_rep] : []}
                      onChange={(names) => setNewCandidate(prev => ({ ...prev, sales_rep: names[0] || '' }))}
                      onClose={() => setShowCandidateSalesPicker(false)}
                      multi={false}
                      addToast={addToast}
                    />
                  )}
                </div>
              )}
              {/* 候補日ごとのCS部員選択（管理者のみ・必須） */}
              {isAdmin && csMembers.length > 0 && (
                <div className="form-group" style={{ marginBottom:8 }}>
                  <div style={{ fontSize:'0.72rem',color:'var(--text-sub)',marginBottom:6,fontWeight:600,textTransform:'none',letterSpacing:0 }}>
                    この候補日のCS部員 *（1〜2名）
                  </div>
                  <button
                    type="button"
                    className={`picker-trigger${(newCandidate.cs_members||[]).length === 0 ? ' empty' : ''}`}
                    onClick={() => setShowCandidateCsPicker(true)}
                  >
                    <span className="picker-trigger-chips">
                      {(newCandidate.cs_members || []).length > 0
                        ? newCandidate.cs_members.map(name => (
                            <span key={name} className="picker-trigger-chip">{name}</span>
                          ))
                        : 'CS部員を選択（必須）'}
                    </span>
                    <span className="picker-trigger-arrow">▼</span>
                  </button>
                  {showCandidateCsPicker && (
                    <StaffPicker
                      title="この候補日のCS部員（必須）"
                      members={csMembers}
                      value={newCandidate.cs_members || []}
                      onChange={(names) => setNewCandidate(prev => ({ ...prev, cs_members: names }))}
                      onClose={() => setShowCandidateCsPicker(false)}
                      multi={true}
                      max={2}
                      addToast={addToast}
                    />
                  )}
                </div>
              )}
              {conflicts && (
                conflicts.blocked ? (
                  <div style={{ fontSize:'0.78rem',color:'var(--danger)',marginBottom:8 }}>
                    🚫 管理者により予定不可{conflicts.blockedInfo?.reason ? `（${conflicts.blockedInfo.reason}）` : ''}
                  </div>
                ) : conflicts.sales_reps?.length >= 2 ? (
                  <div style={{ fontSize:'0.78rem',color:'var(--danger)',marginBottom:8 }}>
                    ⛔ {conflicts.sales_reps.join('さんと ')}さんが抑えているため登録不可
                  </div>
                ) : conflicts.sales_reps?.length === 1 ? (
                  <div style={{ fontSize:'0.78rem',color:'var(--warning)',marginBottom:8 }}>
                    ⚠️ {conflicts.sales_reps[0]}さんが仮抑え中（登録は可能）
                  </div>
                ) : null
              )}
              <div style={{ display:'flex',gap:8 }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={handleCancelEdit}>キャンセル</button>
                <button type="submit" className="btn btn-primary btn-sm"
                  disabled={busy || conflicts?.blocked || conflicts?.sales_reps?.length >= 2 || !(newCandidate.cs_members||[]).length}>
                  {editingCandidateId ? '修正を保存' : '追加する'}
                </button>
              </div>
            </form>
          )}

          {/* 確定済み表示 */}
          {isConfirmed && project.confirmed_date && (
            <div style={{ padding:'12px 14px',borderRadius:8,background:'rgba(16,185,129,0.08)',border:'1px solid rgba(16,185,129,0.25)' }}>
              <div style={{ fontSize:'1rem',fontWeight:600,color:'var(--success)' }}>{formatDateTime(project.confirmed_date)}</div>
            </div>
          )}

          {/* 候補日一覧 */}
          {!isConfirmed && cands.length === 0 && (
            <div style={{ color:'var(--text-sub)',fontSize:'0.85rem' }}>
              {isPending ? '🗓 管理者が候補日を設定します（営業からの設定はできません）' : '候補日がありません'}
            </div>
          )}
          {!isConfirmed && cands.map(c => (
            <div key={c.id} className="confirm-card">
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'0.72rem',color:'var(--text-sub)',marginBottom:2 }}>{c.label}</div>
                <div className="confirm-date">{formatCandDate(c)}</div>
                {c.sales_rep && (
                  <div style={{ fontSize:'0.72rem',color:'var(--text-sub)',marginTop:3 }}>
                    👤 {c.sales_rep}
                  </div>
                )}
                {(c.cs_members || []).length > 0 && (
                  <div style={{ fontSize:'0.72rem',color:'var(--accent-lt)',marginTop:3 }}>
                    🛠 CS：{(c.cs_members || []).join('、')}
                  </div>
                )}
              </div>
              <div style={{ display:'flex',gap:8 }}>
                {canEditCandidates && (
                  <button className="btn btn-ghost btn-sm" onClick={() => handleEditCandidateStart(c)} disabled={busy}>
                    編集
                  </button>
                )}
                {canConfirm && (
                  isAdmin
                    ? <button className="btn btn-success btn-sm" onClick={() => openConfirmModal(c)} disabled={busy}>確定</button>
                    : <button className="btn btn-success btn-sm" onClick={() => handleConfirmDirect(c)} disabled={busy}>確定</button>
                )}
                {canEditCandidates && (
                  <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteCandidate(c.id)} disabled={busy}
                    style={{ color:'var(--danger)',borderColor:'rgba(239,68,68,0.3)' }}>削除</button>
                )}
              </div>
            </div>
          ))}

          {/* 進捗表示・CS部員選択・設定完了ボタン（管理者のみ） */}
          {!isConfirmed && isAdmin && (isPending || isScheduled) && (
            <div style={{ marginTop:12 }}>
              {/* 進捗バー */}
              <div style={{
                padding:'8px 12px',borderRadius:8,marginBottom:12,fontSize:'0.8rem',
                background: candidatesReady ? 'rgba(16,185,129,0.08)' : candidatesOver ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)',
                border: `1px solid ${candidatesReady ? 'rgba(16,185,129,0.25)' : candidatesOver ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)'}`,
                color: candidatesReady ? 'var(--success)' : candidatesOver ? 'var(--danger)' : 'var(--warning)',
              }}>
                {candidatesReady && `✅ 候補日 ${cands.length}/${maxDays} 件 — 希望日数ちょうどです`}
                {candidatesOver && `⚠️ 候補日 ${cands.length}/${maxDays} 件 — 希望日数を超えています。${cands.length - maxDays}件削除してください`}
                {candidatesShort && `🗓 候補日 ${cands.length}/${maxDays} 件 — あと${maxDays - cands.length}件追加してください`}
              </div>

              {/* 候補日ごとのCS担当まとめ表示 */}
              {(() => {
                const allCs = [...new Set(cands.flatMap(c => c.cs_members || []))];
                return allCs.length > 0 ? (
                  <div style={{ marginBottom:12,padding:'8px 12px',background:'rgba(59,130,246,0.06)',border:'1px solid rgba(59,130,246,0.2)',borderRadius:8 }}>
                    <div style={{ fontSize:'0.72rem',color:'var(--text-sub)',marginBottom:4 }}>設定済みCS担当者（各候補日に設定）</div>
                    <div style={{ fontSize:'0.85rem',color:'var(--accent-lt)' }}>🛠 {allCs.join('、')}</div>
                    <div style={{ fontSize:'0.7rem',color:'var(--text-sub)',marginTop:4 }}>
                      ※ 各候補日のCS部員は候補日追加フォームで変更できます
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom:12,padding:'8px 12px',background:'rgba(255,255,255,0.03)',border:'1px solid var(--border)',borderRadius:8,fontSize:'0.8rem',color:'var(--text-sub)' }}>
                    🛠 CS部員未選択（候補日追加フォームで選択してください）
                  </div>
                );
              })()}

              <button className="btn btn-success btn-full" onClick={handleFinalizeCandidates}
                disabled={busy || cands.length === 0}>
                候補日の設定完了（通知メールを送信）
              </button>
            </div>
          )}
        </div>
      )}

      {/* メッセージ（営業⇔管理者のやり取り） */}
      {(isOwner || isAdmin) && (
        <div className="card">
          <div className="section-title">💬 メッセージ（営業・管理者間の連絡）</div>
          <div style={{
            display:'flex', flexDirection:'column', gap:8,
            maxHeight:280, overflowY:'auto', marginBottom:12,
            padding: messages.length ? '4px 2px' : 0,
          }}>
            {messagesLoading ? (
              <div style={{ fontSize:'0.8rem', color:'var(--text-sub)', textAlign:'center', padding:'12px 0' }}>読み込み中...</div>
            ) : messages.length === 0 ? (
              <div style={{ fontSize:'0.8rem', color:'var(--text-sub)', textAlign:'center', padding:'12px 0' }}>まだメッセージはありません</div>
            ) : messages.map(m => {
              const mine = m.sender_login_id === user.login_id;
              return (
                <div key={m.id} style={{
                  alignSelf: mine ? 'flex-end' : 'flex-start',
                  maxWidth: '85%',
                  background: mine ? 'rgba(59,130,246,0.18)' : 'var(--card-bg)',
                  border: `1px solid ${mine ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 12,
                  padding: '8px 12px',
                }}>
                  <div style={{ fontSize:'0.68rem', color:'var(--text-sub)', marginBottom:3, display:'flex', gap:6, alignItems:'center' }}>
                    <span style={{ fontWeight:600 }}>{m.sender_name}</span>
                    <span style={{
                      fontSize:'0.62rem', padding:'0px 6px', borderRadius:99,
                      background: m.sender_role === 'admin' ? 'rgba(139,92,246,0.18)' : 'rgba(16,185,129,0.18)',
                      color: m.sender_role === 'admin' ? '#a78bfa' : 'var(--success)',
                    }}>
                      {m.sender_role === 'admin' ? '管理者' : '営業'}
                    </span>
                    <span>{formatDateTime(m.created_at)}</span>
                  </div>
                  <div style={{ fontSize:'0.85rem', whiteSpace:'pre-wrap', wordBreak:'break-word' }}>{m.body}</div>
                </div>
              );
            })}
          </div>
          <form onSubmit={handleSendMessage} style={{ display:'flex', gap:8 }}>
            <input
              value={messageInput}
              onChange={e => setMessageInput(e.target.value)}
              placeholder="メッセージを入力..."
              style={{ flex:1 }}
              disabled={sendingMessage}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={sendingMessage || !messageInput.trim()}>
              送信
            </button>
          </form>
        </div>
      )}

      {/* アクションボタン */}
      <div style={{ display:'flex',flexDirection:'column',gap:10,marginTop:8 }}>
        {canRemind && (
          <button className="btn btn-ghost btn-full" onClick={handleRemind} disabled={busy}
            style={{ borderColor:'var(--warning)',color:'var(--warning)' }}>
            🔔 リマインドを送信（CS部管理者・自身へメール）
          </button>
        )}
        {canRemindConfirm && (
          <button className="btn btn-ghost btn-full" onClick={handleRemindConfirm} disabled={busy}
            style={{ borderColor:'var(--accent-lt)',color:'var(--accent-lt)' }}>
            🔔 {project.sales_rep}さんへ日程確定を催促
          </button>
        )}
        {canCancel && !isCancelled && (
          <button className="btn btn-ghost btn-sm" onClick={() => setShowCancelModal(true)} disabled={busy}
            style={{ color:'var(--danger)',borderColor:'rgba(239,68,68,0.3)',alignSelf:'flex-start' }}>
            この案件をキャンセル
          </button>
        )}
      </div>

      {/* 管理者専用：ステータス変更 */}
      {isAdmin && !isCancelled && (
        <div className="card" style={{ marginTop:12 }}>
          <div className="section-title">管理者：ステータス変更</div>
          <div style={{ display:'flex',gap:8,flexWrap:'wrap' }}>
            {Object.entries(STATUS_MAP).map(([key, { label }]) =>
              key !== project.status && key !== 'cancelled' && (
                <button key={key} className="btn btn-ghost btn-sm" onClick={() => handleStatusChange(key)} disabled={busy}>
                  {label}へ変更
                </button>
              )
            )}
          </div>
        </div>
      )}

      {isAdmin && (
        <div style={{ marginTop:8 }}>
          <button className="btn btn-danger btn-sm" onClick={handleDelete}>案件を削除</button>
        </div>
      )}
    </>
  );
}
