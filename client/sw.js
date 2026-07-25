// Antigravity Remote サービスワーカー: Web Push 受信と通知タップ処理。
// push イベントで通知を表示し、タップで該当 room の PWA を前面化/起動する。

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* noop */ }
  const title =
    data.reason === "exited" ? "セッション終了" : "入力待ち";
  const body = data.title ? `${data.title}` : "セッションが操作を待っています";
  event.waitUntil(
    self.registration.showNotification("Antigravity Remote: " + title, {
      body,
      tag: "ag-" + (data.sessionId || "session"),
      data,
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const room = event.notification.data && event.notification.data.room;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) { await c.focus(); return; }
      }
      // 開いているタブが無ければ起動(room を引き継ぐ)
      const url = room ? `./?room=${encodeURIComponent(room)}` : "./";
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
