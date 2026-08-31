import type { AlertHit } from '../api/alerts';

/**
 * 데스크톱 알림 (OS 토스트).
 *
 * 앱 안의 벨은 창이 앞에 있어야 눈에 들어온다. 모니터에 띄워둔 화면이 다른 창에
 * 가려 있으면 배지가 바뀌어도 아무도 못 본다 — 그때 필요한 것이 이것이다.
 *
 * **본문은 절대 싣지 않는다.** OS 알림은 잠금화면과 알림센터에 남고, 화면을 공유하는
 * 중에도 뜬다. 로그 한 줄이 거기 남을 이유가 없다. 규칙 이름과 어느 로그인지,
 * 몇 건인지까지다 — 자세한 것은 눌러서 앱 안에서 본다.
 */

const STORAGE_KEY = 'aclv.desktopNotify';

export type NotifyState = 'unsupported' | 'off' | 'on' | 'blocked';

export function notifyState(): NotifyState {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  return isEnabled() ? 'on' : 'off';
}

function isEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function setEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 사생활 보호 모드. 이번 세션에만 동작한다.
  }
}

/**
 * 켜기/끄기. 권한 요청은 반드시 사람이 누른 자리에서 해야 한다 —
 * 로드하자마자 물어보면 브라우저가 무시하고, 사람도 이유를 모른 채 거절한다.
 */
export async function toggleDesktopNotify(): Promise<NotifyState> {
  if (typeof Notification === 'undefined') return 'unsupported';

  if (notifyState() === 'on') {
    setEnabled(false);
    return 'off';
  }

  if (Notification.permission === 'default') {
    const p = await Notification.requestPermission();
    if (p !== 'granted') return p === 'denied' ? 'blocked' : 'off';
  }
  if (Notification.permission !== 'granted') return 'blocked';

  setEnabled(true);
  return 'on';
}

/**
 * 히트 하나를 띄운다.
 *
 * tag 를 규칙 id 로 둔다. 같은 규칙이 또 맞으면 토스트가 쌓이지 않고 갈아끼워진다 —
 * 서버 쿨다운이 이미 한 번 걸러내지만, 규칙이 여럿이면 화면이 토스트로 덮인다.
 */
export async function showHitNotification(
  hit: AlertHit,
  text: { title: string; body: string },
  url: string,
): Promise<void> {
  if (notifyState() !== 'on') return;

  const options: NotificationOptions & { renotify?: boolean } = {
    body: text.body,
    tag: `aclv-rule-${hit.ruleId}`,
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url },
  };

  try {
    // 설치형에서는 서비스워커를 통해야 앱이 뒤에 있어도 확실히 뜨고,
    // 누른 뒤 창을 찾아 띄우는 것도 워커가 해준다.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(text.title, options);
      return;
    }
  } catch {
    // 워커가 없거나 거부됐다. 아래로 떨어진다.
  }

  try {
    const n = new Notification(text.title, options);
    n.onclick = () => {
      window.focus();
      window.location.assign(url);
      n.close();
    };
  } catch {
    // 브라우저가 막았다. 앱 안의 벨은 그대로 동작한다.
  }
}
