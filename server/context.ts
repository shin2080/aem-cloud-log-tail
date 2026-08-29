import type { AppConfig } from './config/env.js';
import type { DbHandle } from './db/index.js';
import { ImsTokenCache } from './adobe/ims.js';
import { CloudManagerClient } from './adobe/cloudmanager.js';
import { LoginRateLimiter } from './auth/ratelimit.js';
import { TailRegistry } from './tail/registry.js';
import { SearchJobRegistry } from './search/jobs.js';
import './parse/register.js'; // 모든 로그 파서를 레지스트리에 등록한다

export interface AppContext {
  cfg: AppConfig;
  handle: DbHandle;
  ims: ImsTokenCache;
  cm: CloudManagerClient;
  loginLimiter: LoginRateLimiter;
  tails: TailRegistry;
  searches: SearchJobRegistry;
}

export function createContext(cfg: AppConfig, handle: DbHandle): AppContext {
  const ims = new ImsTokenCache();
  const cm = new CloudManagerClient(ims);
  return {
    cfg,
    handle,
    ims,
    cm,
    loginLimiter: new LoginRateLimiter(),
    tails: new TailRegistry(cfg, cm),
    searches: new SearchJobRegistry(cfg, cm),
  };
}
