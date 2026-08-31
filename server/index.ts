import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { loadConfigOrExit } from './config/env.js';
import { openDb } from './db/index.js';
import { createContext } from './context.js';
import { seedInitialAdmin } from './auth/seed.js';
import { purgeExpiredSessions } from './auth/session.js';
import { registerAuthGuard, fail } from './auth/middleware.js';
import { purgeOldAudit, auditRowCount } from './auth/audit.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrgRoutes } from './routes/orgs.js';
import { registerEnvironmentRoutes } from './routes/environments.js';
import { registerTailRoutes } from './routes/tail.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerExportRoutes } from './routes/export.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerFilterRoutes } from './routes/filters.js';

const SESSION_PURGE_INTERVAL_MS = 3600_000;
const AUDIT_PURGE_INTERVAL_MS = 24 * 3600_000;

async function main(): Promise<void> {
  const cfg = loadConfigOrExit();
  const handle = openDb(cfg.DATABASE_PATH);
  const ctx = createContext(cfg, handle);

  await seedInitialAdmin(handle.db, cfg);
  const purged = purgeExpiredSessions(handle.db);
  if (purged > 0) console.log(`[auth] 만료 세션 ${purged}건 정리`);
  const purgeTimer = setInterval(() => purgeExpiredSessions(handle.db), SESSION_PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const purgedAudit = purgeOldAudit(handle.db, cfg.AUDIT_RETENTION_DAYS);
  if (purgedAudit > 0) {
    console.log(`[audit] 보존 기간(${cfg.AUDIT_RETENTION_DAYS}일)이 지난 기록 ${purgedAudit}건 정리`);
  }
  const auditTimer = setInterval(
    () => purgeOldAudit(handle.db, cfg.AUDIT_RETENTION_DAYS),
    AUDIT_PURGE_INTERVAL_MS,
  );
  auditTimer.unref();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // 자격증명이 요청/응답 로그에 실려 나가지 않게 한다.
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    trustProxy: cfg.TRUST_PROXY, // 프록시 뒤가 아니면 X-Forwarded-* 를 믿지 않는다.
  });

  await app.register(cookie, { secret: cfg.SESSION_SECRET });

  registerAuthGuard(app, ctx);
  registerAuthRoutes(app, ctx);
  registerOrgRoutes(app, ctx);
  registerEnvironmentRoutes(app, ctx);
  registerTailRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerExportRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  registerFilterRoutes(app, ctx);

  app.get('/api/health', async () => ({ ok: true }));

  // 스택트레이스를 응답에 담지 않는다.
  app.setErrorHandler((err: unknown, req, reply) => {
    req.log.error({ err }, 'unhandled route error');
    const e = err as { statusCode?: number; message?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status === 500) return fail(reply, 500, 'internal_error', 'internal_error');
    return fail(reply, status, 'request_error', 'bad_request');
  });

  // Vite 빌드 산출물을 같은 프로세스에서 정적 서빙한다.
  //
  // tsx 로 소스를 직접 돌릴 때와 dist 를 돌릴 때 경로가 다르다.
  // 소스 web/ 은 index.html 이 /src/main.tsx 를 가리키는 개발용이라 그대로 서빙하면 빈 화면이 된다.
  // assets/ 유무로 '빌드 산출물'인지 가려낸다.
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/server/index.js -> ../web,  server/index.ts -> ../dist/web
  const candidates = [join(here, '..', 'web'), join(here, '..', 'dist', 'web')];
  const findWebRoot = (): string | undefined =>
    candidates.find((c) => existsSync(join(c, 'index.html')) && existsSync(join(c, 'assets')));

  // 정적 루트는 부팅 때 정해야 한다. 아직 없으면 만들어 두고 등록만 해둔다 —
  // wildcard 기본값(true)은 요청마다 디스크에서 찾으므로, 나중에 빌드가 생기거나
  // asset 해시가 바뀌어도 서버를 다시 띄울 필요가 없다.
  // (wildcard:false 는 부팅 때 파일 목록으로 라우트를 만들어, 다시 빌드하면 404 가 된다)
  const staticRoot = findWebRoot() ?? candidates[1]!;
  mkdirSync(staticRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: staticRoot,
    setHeaders: (reply, path) => {
      // 서비스워커는 브라우저가 늘 새로 확인해야 한다. 이걸 캐시하면
      // 모니터에 걸어둔 화면이 몇 주 전 워커를 붙들고 새 배포를 영영 못 받는다.
      if (path.endsWith('/sw.js')) reply.header('Cache-Control', 'no-cache');
    },
  });

  if (!findWebRoot()) {
    console.log('[web] 빌드된 프론트가 없다. `npm run build:web` 을 돌린다 (서버는 다시 띄우지 않아도 된다).');
  }

  // SPA 폴백. @fastify/static 의 reply.sendFile 은 register 의 캡슐화 안에만 있어서
  // 루트 스코프의 notFoundHandler 에서는 보이지 않는다. index.html 을 직접 들고 있는다.
  // 경로도 내용도 캐시하지 않는다. 서버가 도는 중에 프론트를 다시 빌드하면
  // asset 해시가 바뀌고, 아예 없던 dist 가 새로 생기기도 한다.
  // 부팅 시점의 판단을 붙들고 있으면 그때마다 흰 화면이나 404 가 된다.
  // 로컬 전용 도구라 몇 KB 파일을 폴백마다 읽는 비용은 무시할 수 있다.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return fail(reply, 404, 'not_found', 'not_found');
    if (req.method !== 'GET') return fail(reply, 404, 'not_found', 'not_found');

    const root = findWebRoot();
    if (!root) {
      return reply
        .type('text/html; charset=utf-8')
        .code(503)
        .send('<meta charset="utf-8"><pre>프론트가 아직 빌드되지 않았다.\n\n  npm run build:web\n\n(서버는 다시 띄우지 않아도 된다)</pre>');
    }
    return reply.type('text/html; charset=utf-8').send(readFileSync(join(root, 'index.html')));
  });


  const close = async (signal: string): Promise<void> => {
    console.log(`\n[${signal}] 종료한다`);
    ctx.tails.stopAll(); // 폴링 루프를 멈추고 링버퍼를 비운다
    ctx.searches.stopAll();
    await app.close();
    handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('SIGTERM', () => void close('SIGTERM'));

  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  console.log(`\n  AEM Cloud Log Viewer → http://${cfg.HOST}:${cfg.PORT}`);
  console.log(`  조직 ${cfg.orgs.size}개 로드: ${[...cfg.orgs.keys()].join(', ')}`);
  console.log(
    `  감사 기록 ${auditRowCount(handle.db).toLocaleString()}건 ` +
      `(보존 ${cfg.AUDIT_RETENTION_DAYS === 0 ? '영구' : `${cfg.AUDIT_RETENTION_DAYS}일`})`,
  );
  warnIfExposed(cfg);
  console.log('');
}

/**
 * loopback 밖에 바인딩하면 이 도구는 더 이상 '로컬 전용' 이 아니다.
 * 무엇이 열렸고 무엇이 아직 없는지 부팅 때마다 분명히 말한다 —
 * 고객사 prod 로그와 여러 조직의 자격증명을 다루는 도구라 조용히 넘어가면 안 된다.
 */
function warnIfExposed(cfg: ReturnType<typeof loadConfigOrExit>): void {
  const loopback = cfg.HOST === '127.0.0.1' || cfg.HOST === 'localhost' || cfg.HOST === '::1';
  if (loopback) return;

  const missing: string[] = [];
  if (!cfg.SESSION_COOKIE_SECURE) missing.push('SESSION_COOKIE_SECURE=false — 세션 쿠키가 평문 HTTP 로도 전송된다');
  if (!cfg.TRUST_PROXY) missing.push('TRUST_PROXY=false — 프록시 뒤라면 감사 기록의 IP 가 프록시 주소로 남는다');

  console.log('');
  console.log(`  ⚠ ${cfg.HOST} 에 바인딩했다. 이 기기 밖에서 접근할 수 있다.`);
  console.log('    이 서버는 TLS 를 직접 하지 않는다. 암호화가 필요하면 앞단에 두거나');
  console.log('    Tailscale 처럼 네트워크 계층에서 암호화되는 경로로만 접근한다.');
  for (const m of missing) console.log(`    · ${m}`);

  // 설치형(PWA)으로 쓰려면 여기서 한 번 더 걸린다. 나중에 "왜 설치가 안 되지" 로
  // 헤매는 것보다 부팅 때 말해주는 편이 낫다.
  if (!cfg.SESSION_COOKIE_SECURE) {
    console.log('');
    console.log('    설치형(PWA)으로 열려면 https 가 필요하다 — 서비스워커는 보안 컨텍스트에서만 돈다.');
    console.log('    (localhost 는 예외라 이 기기에서는 평문으로도 설치된다)');
    console.log('    Tailscale 이면 `tailscale cert` + `tailscale serve` 로 https 를 붙일 수 있다.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
