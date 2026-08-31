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
