import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users, userOrgs } from '../db/schema.js';
import { hashPassword } from './password.js';
import type { AppConfig } from '../config/env.js';

/**
 * 최초 부팅에 users 가 비어 있을 때만 관리자 1명을 만든다.
 * 회원가입 엔드포인트는 존재하지 않는다 — 계정은 관리자가 발급한다.
 */
export async function seedInitialAdmin(db: Db, cfg: AppConfig): Promise<void> {
  const count = db.select({ n: sql<number>`count(*)` }).from(users).get()?.n ?? 0;
  if (count > 0) return;

  const email = cfg.ADMIN_EMAIL.toLowerCase();
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email,
    passwordHash: await hashPassword(cfg.ADMIN_INITIAL_PASSWORD),
    displayName: '관리자',
    role: 'admin',
    mustChangePassword: 1,
    isActive: 1,
    createdAt: Date.now(),
  });

  // 최초 관리자에게는 .env 에 등록된 모든 조직을 붙여준다.
  // 그러지 않으면 계정을 만들자마자 아무 환경도 볼 수 없다.
  // prod 열람까지 함께 열리므로 아래 콘솔에 그 사실을 분명히 적는다.
  const orgKeys = [...cfg.orgs.keys()];
  if (orgKeys.length > 0) {
    db.insert(userOrgs)
      .values(orgKeys.map((orgKey) => ({ userId: id, orgKey, allowProd: 1 })))
      .run();
  }

  console.log(
    [
      '',
      '  ┌─────────────────────────────────────────────────────────────',
      '  │ 최초 관리자 계정을 만들었다.',
      `  │   이메일: ${email}`,
      '  │   비밀번호: .env 의 ADMIN_INITIAL_PASSWORD',
      '  │',
      `  │   조직 접근: ${orgKeys.join(', ') || '(없음)'} — prod 열람 포함`,
      '  │',
      '  │ 첫 로그인에서 비밀번호 변경을 요구한다.',
      '  │ 변경 후 .env 의 ADMIN_INITIAL_PASSWORD 는 지운다.',
      '  └─────────────────────────────────────────────────────────────',
      '',
    ].join('\n'),
  );
}
