// 주누디자인 고객 문자·알림톡 센터 서비스워커 (PWA 독립 창 앱 & 초고속 구동)
const CACHE_NAME = 'joonoo-sms-v100';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = e.request.url;
  // 클라우드 API 요청(Apps Script, Solapi 등)은 절대 캐싱하지 않음
  if (
    url.includes('script.google.com') ||
    url.includes('script.googleusercontent.com') ||
    url.includes('api.solapi.com')
  ) {
    return;
  }

  // 강제 새로고침(?t=...) 파라미터 시 네트워크 우선 갱신
  if (url.includes('?t=')) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Stale-While-Revalidate 전략: 0.01초 즉시 렌더링 후 백그라운드 최신화
  e.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(e.request, { ignoreSearch: true }).then((cached) => {
        const networkFetch = fetch(e.request)
          .then((res) => {
            if (res && res.status === 200 && (url.startsWith(self.location.origin) || url.includes('pretendard'))) {
              cache.put(e.request, res.clone());
            }
            return res;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    )
  );
});
