// 画面共通の定数（案件登録と案件情報の編集で同じ選択肢を使うため、ここで一元管理する）
export const PROJECT_TYPES = ['新規納品', '増設納品', 'PC入替え', 'I/O機器納品', '打合せ', '調査'];
export const DELIVERY_LABELS = { remote: '🖥 リモート', onsite: '🚗 現地訪問' };
export const MEMO_MAX = 50; // 備考の文字数上限（サーバー側と同じ）
