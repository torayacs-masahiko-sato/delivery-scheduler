// パスキー（顔認証・指紋認証・端末PIN）の画面側処理
// 端末の認証画面（Face ID / Windows Hello など）を呼び出し、結果をサーバーへ送る。
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from './api';

export const passkeySupported = () => {
  try { return browserSupportsWebAuthn(); } catch { return false; }
};

// 端末名の初期値（一覧で見分けるため）。例: 「iPhone（2026/10/23登録）」
export function guessDeviceName() {
  const ua = navigator.userAgent || '';
  const kind = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Androidスマホ'
    : /Windows/.test(ua) ? 'Windows PC'
    : /Macintosh/.test(ua) ? 'Mac'
    : 'この端末';
  const d = new Date();
  return `${kind}（${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}登録）`;
}

// 端末側のエラーを分かりやすい日本語に変換
function friendly(err) {
  const name = err?.cause?.name || err?.name;
  const code = err?.code;
  if (name === 'NotAllowedError' || code === 'ERROR_CEREMONY_ABORTED') return 'キャンセルされたか、時間切れになりました。もう一度お試しください';
  if (code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'この端末はすでに登録されています';
  if (code === 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT') return 'この端末は生体認証・PINに対応していないため登録できません';
  if (code === 'ERROR_INVALID_DOMAIN' || code === 'ERROR_INVALID_RP_ID') return 'このURLではパスキーを使用できません（正式なURLからアクセスしてください）';
  return err?.message || 'パスキーの処理に失敗しました';
}

/** 登録（ログイン済みのとき） */
export async function registerPasskey(deviceName) {
  const { options, challenge_token } = await api.passkeyRegisterOptions();
  let response;
  try { response = await startRegistration({ optionsJSON: options }); }
  catch (err) { throw new Error(friendly(err)); }
  return api.passkeyRegisterVerify(response, challenge_token, deviceName);
}

/** ログイン（成功するとログイン済みユーザー情報を返す） */
export async function loginWithPasskey() {
  const { options, challenge_token } = await api.passkeyLoginOptions();
  let response;
  try { response = await startAuthentication({ optionsJSON: options }); }
  catch (err) { throw new Error(friendly(err)); }
  return api.passkeyLoginVerify(response, challenge_token);
}
