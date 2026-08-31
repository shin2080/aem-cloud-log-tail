/**
 * 서비스워커 등록.
 *
 * 서비스워커는 보안 컨텍스트에서만 돈다 — https 이거나 localhost 여야 한다.
 * Tailscale 주소로 평문 HTTP 접근하면 등록 자체가 안 된다. 그때는 조용히 넘어가고
 * 앱은 평소대로 동작한다 (설치형으로 안 될 뿐 기능은 같다).
 */

/** 새 배포가 올라와 워커가 바뀌었을 때 한 번만 새로고침한다. */
let reloading = false;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // 개발 중에는 등록하지 않는다. Vite 의 HMR 과 캐시가 서로 방해한다.
  if (!import.meta.env.PROD) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      // 대개는 보안 컨텍스트가 아니라서다. 왜 설치가 안 되는지는 알려줘야 한다.
      console.warn(
        '[pwa] 서비스워커를 등록하지 못했다. https 또는 localhost 여야 한다.',
        err,
      );
    });
  });

  /**
   * 새 워커가 화면을 넘겨받았다 = 새 배포가 올라왔다.
   *
   * 모니터에 걸어두는 화면은 사람이 새로고침을 눌러주지 않는다. 그대로 두면
   * 몇 주 전 번들이 계속 돌면서, 고쳐놓은 버그가 그 화면에서만 살아 있게 된다.
   * 보고 있던 창은 URL 에 들어 있으므로 새로고침해도 그대로 돌아온다.
   */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

/** 로그아웃할 때. 캐시에 껍데기밖에 없더라도 '나가면 안 남는다' 를 지킨다. */
export function purgeServiceWorkerCaches(): void {
  navigator.serviceWorker?.controller?.postMessage({ type: 'purge' });
}

/* ── 설치 안내 ────────────────────────────────────────────
 *
 * 설치형으로 열면 창 장식이 사라지고 알림이 앱처럼 뜬다. 모니터에 걸어두는
 * 쓰임에서는 그게 기본값이어야 하는데, 브라우저 주소창의 설치 아이콘은
 * 아무도 안 본다. 그래서 화면 위에서 한 번 말해준다.
 *
 * 대신 **설치할 수 없는 상황에서는 말하지 않는다.** 평문 HTTP 나 Firefox 처럼
 * 설치 경로가 없는 곳에서 "설치하세요" 라고 띄우면 시키는 대로 해도 안 되는
 * 안내가 된다.
 */

/** 크로미움이 "설치할 수 있다" 고 알려줄 때 주는 이벤트 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'aclv.installDismissed';

/** 'prompt' = 진짜 설치 버튼을 줄 수 있다, 'manual' = 방법만 알려줄 수 있다 */
export type InstallState = 'hidden' | 'prompt' | 'manual';

let deferred: InstallPromptEvent | null = null;
const watchers = new Set<() => void>();

function notify(): void {
  for (const fn of watchers) fn();
}

/** 이미 설치형으로 열려 있는가 */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari 는 표준 미디어 쿼리 대신 이걸 쓴다
  return (navigator as unknown as { standalone?: boolean }).standalone === true;
}

/**
 * iOS Safari 인가.
 *
 * 여기서는 beforeinstallprompt 가 영영 안 온다. 대신 '공유 → 홈 화면에 추가' 로
 * 설치가 되므로, 버튼 대신 방법을 알려줄 수 있는 유일한 예외다.
 */
function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return ios && webkit;
}

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function dismissInstallBanner(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // 사생활 보호 모드. 이번 세션에만 숨는다.
  }
  notify();
}

export function installState(): InstallState {
  if (isStandalone() || dismissed()) return 'hidden';
  if (deferred) return 'prompt';
  if (isIosSafari()) return 'manual';
  return 'hidden';
}

export function onInstallStateChange(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

/** 설치 창을 띄운다. 브라우저 규칙상 사람이 누른 자리에서만 통한다. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const e = deferred;
  // 한 이벤트는 한 번만 쓸 수 있다. 먼저 비워야 두 번 눌러도 터지지 않는다.
  deferred = null;
  notify();
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    return outcome;
  } catch {
    return 'unavailable';
  }
}

/*
 * 이 이벤트는 React 가 붙기 전에 온다. 컴포넌트 안에서 듣기 시작하면 놓친다 —
 * 그래서 모듈이 읽히는 시점에 잡아둔다.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // 브라우저 기본 배너 대신 우리가 자리를 고른다
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}
