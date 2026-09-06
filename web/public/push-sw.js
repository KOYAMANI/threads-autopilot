/**
 * Service Worker に足す Push の受け口（SPEC §7.8 / §12.4、M7）。
 *
 * `vite-plugin-pwa` は `generateSW` モードで Workbox の SW を自動生成するので、
 * 自前のイベントハンドラは `workbox.importScripts` でこのファイルを読み込ませて足す
 * （`injectManifest` に切り替えると precache の面倒を全部こちらで見ることになる。
 * 足したいのはハンドラ2つだけなので、その代償は大きすぎる。vite.config.ts 参照）。
 *
 * サーバー（`worker/src/lib/webpush.ts`）が送るペイロードは
 * `{"title":"…","body":"…","url":"/app/queue"}` の JSON。
 * **承認・取消のワンタイム URL は入っていない**（`jobs/notify.ts` のコメント）。
 * 通知はロック画面にも出るので、押すだけで確定できるリンクは置かない。
 */

self.addEventListener("push", (event) => {
  let data = { title: "Threads オートパイロット", body: "", url: "/app/queue" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // JSON でないペイロード（他所から来たもの）。既定の文言で出す
    try {
      if (event.data) data.body = event.data.text();
    } catch {
      /* 読めなければ本文なしで出す */
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // 同じ tag の通知は置き換わる。下書きの通知が何枚も溜まらないようにする
      tag: "tap-notification",
      renotify: true,
      data: { url: data.url || "/app/queue" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    (event.notification.data && event.notification.data.url) || "/app/queue",
    self.location.origin,
  ).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // すでに開いているタブがあれば、新しく開かずにそこへ寄せる
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
