// 네트워크 우선(Network-First) + 1.2초 타임아웃 캐시 폴백(캐시가 있을 때만). 외부 요청(구글/솔라피/카페24)은 절대 가로채지 않음.
const CACHE_NAME = 'joonoo-sms-v3.4';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부(구글 Apps Script·솔라피·CDN)는 통과

  url.search = '';
  const key = req.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : url.href;

  event.respondWith(
    caches.match(key, { ignoreSearch: true }).then((cached) => {
      // 백그라운드에서도 최신 파일은 항상 캐시 갱신 (GitHub Pages 10분 HTTP 캐시 우회)
      const networkPromise = fetch(key, { cache: 'no-store' }).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(key, copy));
        }
        return res;
      });

      // 최초 무캐시 접속 시에는 타임아웃 abort 금지 (끝까지 네트워크 대기)
      if (!cached) {
        return networkPromise;
      }

      // 캐시가 있을 때만 1.2초 네트워크 레이스 → 느린 LTE/5G에서도 1.2초 내 즉시 열림 + 최신본은 백그라운드 캐시 갱신
      event.waitUntil(networkPromise.catch(() => {}));
      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(cached);
          }
        }, 1200);

        networkPromise.then((res) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(res && res.ok ? res : cached);
          }
        }).catch(() => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve(cached);
          }
        });
      });
    })
  );
});
