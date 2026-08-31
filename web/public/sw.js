/*
 * 서비스워커.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 이 파일의 첫 번째 규칙: **로그는 절대 디스크에 남기지 않는다.**
 *
 * 이 도구의 설계 전제가 "로그 본문은 메모리에만 있고 프로세스가 죽으면 사라진다" 인데,
 * 서비스워커가 API 응답을 CacheStorage 에 넣는 순간 그게 무너진다.
 * 고객사 prod 로그가 평문으로 디스크에 남고, 로그아웃해도 안 지워지고,
 * 같은 기기에 다른 사람이 로그인해도 앞사람의 캐시가 읽힌다.
 *
 * Workbox 의 흔한 레시피(`runtimeCaching` 에 /api 를 넣는 것)가 정확히 그 일을 한다.
 * 그래서 라이브러리를 쓰지 않고 직접 썼다. 캐시에 들어가는 것은 앱 껍데기뿐이다 —
 * HTML, 해시가 박힌 JS/CSS. 그 밖에는 아무것도 손대지 않는다.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 하는 일은 하나다: 앱을 빨리, 그리고 서버가 잠깐 죽어도 열리게 한다.
 * 로그 자체는 SSE 로 서버에서 직접 오므로 오프라인에서 볼 수 있는 것은 없다.
 */

const CACHE = 'aclv-shell-v1';

/** 이 경로로 가는 것은 서비스워커가 아예 건드리지 않는다. */
function isOffLimits(url) {
  return url.pathname.startsWith('/api/');
}

/** Vite 가 내는 산출물. 파일 이름에 내용 해시가 박혀 있어 캐시가 낡을 수 없다. */
function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/');
}

self.addEventListener('install', (event) => {
  // 껍데기 하나만 미리 받아둔다. 나머지는 실제로 쓰일 때 담긴다.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add(new Request('/', { cache: 'reload' })))
      .catch(() => {
        // 설치 시점에 서버가 없을 수도 있다. 그래도 워커는 살아야 한다.
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * 화면이 보내는 신호.
 * `purge` 는 로그아웃할 때 온다 — 껍데기에 비밀이 들어 있지는 않지만,
 * '나가면 아무것도 안 남는다' 는 약속을 기계적으로 지키는 편이 낫다.
 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'purge') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

/**
 * 데스크톱 알림을 눌렀을 때.
 *
 * 이미 열려 있는 창이 있으면 그 창을 앞으로 가져와 그 자리로 보낸다.
 * 새 창을 여는 것은 마지막 수단이다 — 모니터에 띄워둔 화면이 있는데 창이 하나 더
 * 생기면, 사람이 알림을 누를수록 화면이 늘어난다.
 */
self.addEventListener('notificationclick', (event) => {
  const url = event.notification.data?.url || '/';
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const c of all) {
        if (!c.url.startsWith(self.location.origin)) continue;
        // navigate 가 없는 브라우저도 있다. 그때는 앞으로 가져오기만 한다.
        if ('navigate' in c) return c.navigate(url).then((n) => n?.focus());
        return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET 이 아닌 것, 다른 출처, 그리고 /api/* 는 손대지 않는다.
  // respondWith 를 부르지 않으면 브라우저가 평소대로 처리한다 — SSE 도 그대로 흐른다.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isOffLimits(url)) return;

  // 화면 이동: 네트워크가 먼저다. 안 되면 캐시해둔 껍데기로 연다.
  // 캐시가 먼저이면 새로 배포해도 낡은 화면이 계속 뜬다.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  // 해시가 박힌 자산: 캐시가 먼저다. 내용이 바뀌면 이름도 바뀌므로 낡을 수가 없다.
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        });
      }),
    );
    return;
  }

  // 그 밖의 것(아이콘, manifest)은 그냥 네트워크로 보낸다. 굳이 캐시할 이유가 없다.
});
