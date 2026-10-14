import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 실행 중인 버전. package.json 에서 읽는다.
 *
 * tsx 로 소스를 돌릴 때(server/version.ts)와 dist 를 돌릴 때(dist/server/version.js)
 * package.json 까지의 거리가 다르다. 가까운 쪽부터 본다 — 먼 쪽을 먼저 보면
 * 소스 실행에서 저장소 바깥의 엉뚱한 package.json 을 집을 수 있다.
 */
export function readAppVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../package.json', '../../package.json']) {
    const p = join(here, rel);
    if (!existsSync(p)) continue;
    try {
      const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version;
      if (v) return v;
    } catch {
      // 다음 후보
    }
  }
  return '0.0.0';
}
