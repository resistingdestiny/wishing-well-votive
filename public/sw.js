/* Wishing Well web-push service worker. Shows a notification on push and focuses
   (or opens) the relevant wish/board on click. No vendor — self-VAPID. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: "Wishing Well", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Wishing Well";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag,
      data: { url: data.url || "/" },
      badge: undefined,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c && c.url.includes(url)) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
