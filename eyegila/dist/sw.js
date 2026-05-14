// Service worker for EyeGila push notifications

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'EyeGila', body: event.data.text() };
  }

  const title = payload.title ?? 'EyeGila';
  const options = {
    body: payload.body ?? '',
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    data: payload.data ?? {},
    tag: payload.tag ?? 'eyegila-notification',
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const videoId = event.notification.data?.video_id;
  const url = videoId ? `/videos/${videoId}` : '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Focus an existing tab if one is open
        for (const client of windowClients) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        // Otherwise open a new tab
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      })
  );
});
