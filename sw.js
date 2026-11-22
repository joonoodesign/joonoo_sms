// 네트워크 우선(Network-First) + 오프라인 폴백. 앱 파일만 캐시하고 구글/솔라피 등 외부 요청은 절대 가로채지 않음.
const CACHE_NAME = 'joonoo-sms-v3.2';
const ASSETS = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // cache:'reload' → 브라우저 HTTP 캐시(깃허브 페이지 10분)를 건너뛰고 항상 최신 파일로 설치
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

  // ?v=123 / ?phone= 등 쿼리 무시: 화면(내비게이션)은 항상 index.html 한 개 키로 관리
  url.search = '';
  const key = req.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : url.href;

  // 주의: navigate 요청 객체에 옵션을 붙여 fetch(req, {...})하면 TypeError → 옛 캐시만 계속 뜨는 원인이었음. URL 문자열로 새로 요청.
  event.respondWith(
    fetch(key, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key, { ignoreSearch: true }))
  );
});
