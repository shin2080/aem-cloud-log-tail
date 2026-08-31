import type { AppConfig } from './config/env.js';
import type { DbHandle } from './db/index.js';
import { ImsTokenCache } from './adobe/ims.js';
import { CloudManagerClient } from './adobe/cloudmanager.js';
import { LoginRateLimiter } from './auth/ratelimit.js';
import { TailRegistry } from './tail/registry.js';
import { SearchJobRegistry } from './search/jobs.js';
import { AlertWatcher } from './alerts/watch.js';
import './parse/register.js'; // 모든 로그 파서를 레지스트리에 등록한다

export interface AppContext {
  cfg: AppConfig;
  handle: DbHandle;
  ims: ImsTokenCache;
  cm: CloudManagerClient;
  loginLimiter: LoginRateLimiter;
  tails: TailRegistry;
  searches: SearchJobRegistry;
  /** 규칙이 걸린 대상을 아무도 안 봐도 따라간다 */
  alerts: AlertWatcher;
}

export function createContext(cfg: AppConfig, handle: DbHandle): AppContext {
  const ims = new ImsTokenCache();
  const cm = new CloudManagerClient(ims);
  const ctx: AppContext = {
    cfg,
    handle,
    ims,
    cm,
    loginLimiter: new LoginRateLimiter(),
    tails: new TailRegistry(cfg, cm),
    searches: new SearchJobRegistry(cfg, cm),
    // watcher 는 ctx 를 되짚어 봐야 해서(권한 확인·세션 구독) 뒤에 붙인다.
    alerts: undefined as unknown as AlertWatcher,
  };
  ctx.alerts = new AlertWatcher(ctx);
  return ctx;
}
