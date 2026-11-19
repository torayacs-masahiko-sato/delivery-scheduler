// 関連URL（複数）の入力欄と表示部品
// 1行 = { url, label }。label は「契約場所」「納品場所」など、そのURLが何かを表すコメント。
// 案件登録画面と案件詳細の編集画面の両方で使う。

export const MAX_URLS = 10;          // サーバー側の上限と同じ
export const MAX_URL_LABEL = 30;     // コメントの文字数上限（サーバー側と同じ）
export const URL_LABEL_SUGGESTIONS = ['顧客情報', '契約場所', '納品場所', '地図', '見積書', '資料'];

/** URLもコメントも空の行を取り除き、前後の空白を削る（保存前に使う） */
export function cleanUrlRows(rows) {
  return (rows || [])
    .map(r => ({ url: (r.url || '').trim(), label: (r.label || '').trim() }))
    .filter(r => r.url || r.label);
}

/** 入力チェック。問題があればエラーメッセージ、なければ null */
export function validateUrlRows(rows) {
  const list = cleanUrlRows(rows);
  for (const r of list) {
    if (!r.url) return `コメント「${r.label}」のURLを入力してください`;
    if (!/^https?:\/\//i.test(r.url)) return 'URLは http:// または https:// から入力してください';
    if (r.label.length > MAX_URL_LABEL) return `URLのコメントは${MAX_URL_LABEL}文字以内で入力してください`;
  }
  if (list.length > MAX_URLS) return `関連URLは${MAX_URLS}件まで登録できます`;
  return null;
}

/** 入力欄（行の追加・削除つき） */
export function UrlListEditor({ rows, onChange, idPrefix = 'url' }) {
  const update = (i, key, value) => onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
  const remove = (i) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { url: '', label: '' }]);
  const listId = `${idPrefix}-label-suggestions`;

  return (
    <div>
      {/* コメントの入力候補（入力欄をタップすると候補が出る。自由入力も可） */}
      <datalist id={listId}>
        {URL_LABEL_SUGGESTIONS.map(s => <option key={s} value={s} />)}
      </datalist>

      {rows.length === 0 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-sub)', marginBottom: 8 }}>登録されているURLはありません</div>
      )}

      {rows.map((r, i) => (
        <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <input
              list={listId}
              value={r.label}
              maxLength={MAX_URL_LABEL}
              onChange={e => update(i, 'label', e.target.value)}
              placeholder="コメント（例：納品場所）"
              aria-label={`URL${i + 1}のコメント`}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(i)}
              aria-label={`URL${i + 1}を削除`} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
              ✕ 削除
            </button>
          </div>
          <input
            type="url"
            inputMode="url"
            value={r.url}
            onChange={e => update(i, 'url', e.target.value)}
            placeholder="https://example.com/..."
            aria-label={`URL${i + 1}`}
            style={{ width: '100%' }}
          />
        </div>
      ))}

      <button type="button" className="btn btn-ghost btn-sm" onClick={add} disabled={rows.length >= MAX_URLS}>
        ＋ URLを追加
      </button>
      {rows.length >= MAX_URLS && (
        <span style={{ fontSize: '0.72rem', color: 'var(--text-sub)', marginLeft: 8 }}>（{MAX_URLS}件まで）</span>
      )}
    </div>
  );
}

/** 表示用（コメント＋リンク）。コメントが空の場合は「（コメントなし）」 */
export function UrlListView({ rows, emptyText = '未登録' }) {
  const list = cleanUrlRows(rows).filter(r => r.url);
  if (!list.length) return <div className="meta-value" style={{ color: 'var(--text-sub)' }}>{emptyText}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {list.map((r, i) => (
        <div key={i}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-sub)' }}>
            {r.label || '（コメントなし）'}
          </div>
          <a href={r.url} target="_blank" rel="noopener noreferrer"
            style={{ color: 'var(--accent-lt)', wordBreak: 'break-all', fontSize: '0.88rem' }}>
            🔗 {r.url}
          </a>
        </div>
      ))}
    </div>
  );
}
