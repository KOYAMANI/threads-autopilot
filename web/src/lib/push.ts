/**
 * Web Push の購読（SPEC §7.8 / §12.4）。
 *
 * ブラウザ側は Service Worker（`vite-plugin-pwa` が出すもの）の `pushManager` を使う。
 * 購読できた `endpoint` と鍵はサーバーの `push_subscriptions` に**暗号化して**入る。
 * 実際の送信は M7（DECISIONS.md 2026-09-06）。ここは登録と解除まで。
 */
import { api } from "../api/client";

export type PushResult = { ok: true } | { ok: false; message: string };

/** VAPID の公開鍵（base64url）を `Uint8Array` に直す。 */
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * 通知の許可を取り、購読してサーバーに登録する。
 * 断られた・使えない場合は理由を日本語で返す（画面はトーストに出す）。
 */
export async function subscribePush(vapidPublicKey: string): Promise<PushResult> {
  if (!pushSupported()) {
    return { ok: false, message: "この端末では通知を使えません" };
  }
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, message: "通知の許可を確認できませんでした" };
  }
  if (permission !== "granted") {
    return { ok: false, message: "ブラウザの設定で通知が許可されていません" };
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      }));
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
      return { ok: false, message: "購読の情報が足りませんでした" };
    }
    await api.post("/push/subscribe", {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
    return { ok: true };
  } catch {
    return { ok: false, message: "通知を登録できませんでした" };
  }
}

/** 端末側の購読を解除し、サーバーからも消す。 */
export async function unsubscribePush(): Promise<PushResult> {
  let endpoint: string | null = null;
  if (pushSupported()) {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    } catch {
      // 端末側で解除できなくても、サーバー側の行は消しておく
    }
  }
  try {
    // endpoint が取れなければ、このユーザーの購読を全部消す（設定のオフから呼ぶため）
    await api.del("/push/subscribe", endpoint ? { endpoint } : {});
  } catch {
    return { ok: false, message: "通知の解除に失敗しました" };
  }
  return { ok: true };
}
