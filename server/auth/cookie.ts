import type { AppConfig } from '../config/env.js';

/**
 * 세션 쿠키 옵션. 로그인·비밀번호 변경·슬라이딩 갱신 세 곳이 같은 값을 써야 한다.
 * 한 군데만 어긋나도(예: 갱신 때 sameSite 를 빠뜨리면) 브라우저가 쿠키를 갈아치우면서
 * 보호 속성이 조용히 풀린다.
 */
export function sessionCookieOptions(cfg: AppConfig): {
  httpOnly: true;
  sameSite: 'strict';
  path: '/';
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: cfg.SESSION_COOKIE_SECURE,
  };
}
