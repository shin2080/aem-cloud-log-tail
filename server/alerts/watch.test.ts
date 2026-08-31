import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { openDb, type DbHandle } from '../db/index.js';
import { users, userOrgs, envCache, alertRules, alertHits } from '../db/schema.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import type { AppContext } from '../context.js';
import type { LogEntry } from '../../shared/types.js';
import type { TailEvent, TailKey } from '../tail/session.js';
import '../parse/register.js';
import { AlertWatcher, unreadCount } from './watch.js';

const ENV: NodeJS.ProcessEnv = {
  SESSION_SECRET: 'x'.repeat(64),
  ADMIN_EMAIL: 'a@example.com',
  ADMIN_INITIAL_PASSWORD: 'a-long-password',
  ORG_1_KEY: 'acme',
  ORG_1_LABEL: 'ACME',
  ORG_1_IMS_ORG_ID: 'A@AdobeOrg',
  ORG_1_CLIENT_ID: 'c',
  ORG_1_CLIENT_SECRET: 's',
  ORG_1_SCOPES: 'openid',
  ALERT_MAX_TARGETS: '2',
};

/** 구독 요청을 받아 리스너를 붙잡아 두는 가짜 레지스트리 */
class FakeTails {
  readonly listeners = new Map<string, (e: TailEvent) => void>();
  released: string[] = [];

  async subscribe(key: TailKey, _org: unknown, _pid: string, fn: (e: TailEvent) => void) {
    const id = `${key.orgKey} ${key.environmentId} ${key.service} ${key.logName}`;
    this.listeners.set(id, fn);
    return {
      session: {} as never,
      unsubscribe: () => {
        this.listeners.delete(id);
        this.released.push(id);
      },
    };
  }

  /** 그 대상을 보고 있는 watcher 에게 엔트리를 흘린다 */
  feed(id: string, entries: LogEntry[]): void {
    this.listeners.get(id)?.({ type: 'entries', entries });
  }
}

let handle: DbHandle;
let cfg: AppConfig;
let tails: FakeTails;
let ctx: AppContext;
let watcher: AlertWatcher;
let userId: string;

const TARGET = 'acme 987654 author aemerror';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    seq: 1,
    ts: 1_700_000_000_000,
    level: 'ERROR',
    pod: '',
    thread: 'qtp-1',
    logger: 'com.adobe.cq.Foo',
    message: 'OutOfMemoryError: Java heap space',
    continuation: [],
    raw: '29.08.2026 12:00:01.234 *ERROR* [qtp-1] com.adobe.cq.Foo OutOfMemoryError: Java heap space',
    ...over,
  };
}

function makeRule(over: Partial<typeof alertRules.$inferInsert> = {}): string {
  const id = randomUUID();
  handle.db
    .insert(alertRules)
    .values({
      id,
      userId,
      name: '메모리',
      orgKey: 'acme',
      environmentId: '987654',
      service: 'author',
      logName: 'aemerror',
      pattern: 'OutOfMemory',
      isRegex: 0,
      levels: null,
      cooldownSec: 300,
      enabled: 1,
      createdAt: Date.now(),
      ...over,
    })
    .run();
  return id;
}

beforeEach(() => {
  handle = openDb(':memory:');
  cfg = loadConfig(ENV);
  tails = new FakeTails();

  userId = randomUUID();
  handle.db
    .insert(users)
    .values({
      id: userId,
      email: 'u@example.com',
      passwordHash: 'x',
      displayName: '테스트',
      role: 'member',
      createdAt: Date.now(),
    })
    .run();
  handle.db.insert(userOrgs).values({ userId, orgKey: 'acme', allowProd: 0 }).run();
  handle.db
    .insert(envCache)
    .values({
      orgKey: 'acme',
      programId: '1',
      programName: 'p',
      environmentId: '987654',
      environmentName: 'dev',
      environmentType: 'dev',
      availableServices: null,
      refreshedAt: Date.now(),
    })
    .run();

  ctx = { cfg, handle, tails } as unknown as AppContext;
  watcher = new AlertWatcher(ctx);
  (ctx as { alerts: AlertWatcher }).alerts = watcher;
});

describe('알림 감시 — 대상 잡기', () => {
  test('규칙이 있는 대상을 구독한다 — 아무도 안 봐도 돌아야 한다', async () => {
    makeRule();
    await watcher.sync();
    assert.equal(watcher.watchedCount, 1);
    assert.ok(tails.listeners.has(TARGET));
  });

  test('규칙이 없으면 아무것도 잡지 않는다', async () => {
    await watcher.sync();
    assert.equal(watcher.watchedCount, 0);
  });

  test('규칙을 끄면 구독을 놓는다 — 폴링이 계속 돌면 안 된다', async () => {
    const id = makeRule();
    await watcher.sync();
    handle.db.update(alertRules).set({ enabled: 0 }).where(eq(alertRules.id, id)).run();
    await watcher.sync();
    assert.equal(watcher.watchedCount, 0);
    assert.deepEqual(tails.released, [TARGET]);
  });

  test('같은 대상의 규칙 둘은 구독 하나를 나눠 쓴다', async () => {
    makeRule();
    makeRule({ name: '다른 규칙', pattern: 'timeout' });
    await watcher.sync();
    assert.equal(watcher.watchedCount, 1);
  });

  /** 상한을 넘긴 규칙은 조용히 안 도는 게 아니라 꺼지고 이유가 남아야 한다 */
  test('대상 상한을 넘으면 규칙을 끄고 이유를 남긴다', async () => {
    makeRule({ service: 'author' });
    makeRule({ service: 'publish' });
    const third = makeRule({ service: 'preview_publish' });
    await watcher.sync();

    assert.equal(watcher.watchedCount, 2, 'ALERT_MAX_TARGETS=2');
    const row = handle.db.select().from(alertRules).where(eq(alertRules.id, third)).get();
    assert.equal(row?.enabled, 0);
    assert.equal(row?.disabledReason, 'too_many_targets');
  });

  test('권한이 없어진 규칙은 끄고 이유를 남긴다', async () => {
    const id = makeRule();
    await watcher.sync();
    handle.db.delete(userOrgs).where(eq(userOrgs.userId, userId)).run();
    await watcher.sync();

    const row = handle.db.select().from(alertRules).where(eq(alertRules.id, id)).get();
    assert.equal(row?.enabled, 0);
    assert.equal(row?.disabledReason, 'access_revoked');
    assert.equal(watcher.watchedCount, 0);
  });
});

describe('알림 감시 — 맞히기', () => {
  test('패턴이 맞으면 히트를 남긴다', async () => {
    makeRule();
    await watcher.sync();
    tails.feed(TARGET, [entry()]);

    const hits = handle.db.select().from(alertHits).all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.count, 1);
    assert.equal(unreadCount(handle.db, userId), 1);
  });

  test('안 맞으면 아무 일도 없다', async () => {
    makeRule({ pattern: '없는말' });
    await watcher.sync();
    tails.feed(TARGET, [entry()]);
    assert.equal(handle.db.select().from(alertHits).all().length, 0);
  });

  test('레벨 필터를 지킨다', async () => {
    makeRule({ levels: 'ERROR' });
    await watcher.sync();
    tails.feed(TARGET, [entry({ level: 'WARN' })]);
    assert.equal(handle.db.select().from(alertHits).all().length, 0);
  });

  test('열려 있는 화면으로 밀어줄 이벤트를 낸다', async () => {
    const got: string[] = [];
    watcher.subscribe((e) => got.push(e.ruleName));
    makeRule();
    await watcher.sync();
    tails.feed(TARGET, [entry()]);
    assert.deepEqual(got, ['메모리']);
  });
});

/**
 * 이 describe 가 이 기능에서 가장 중요한 부분이다.
 * 규칙 하나가 초당 수십 번 맞을 수 있는데, 그때마다 알림을 만들면
 * 알림함이 쓸모없어지고 사람이 알림을 무시하기 시작한다.
 */
describe('알림 감시 — 소음 제어', () => {
  test('같은 사건이 쿨다운 안에 다시 오면 건수만 올린다', async () => {
    makeRule({ cooldownSec: 300 });
    await watcher.sync();

    for (let i = 0; i < 20; i++) tails.feed(TARGET, [entry({ seq: i })]);

    const hits = handle.db.select().from(alertHits).all();
    assert.equal(hits.length, 1, '알림은 하나여야 한다');
    assert.equal(hits[0]!.count, 20, '건수는 다 세야 한다');
    assert.equal(hits[0]!.lastSeq, 19, '마지막 자리를 가리켜야 한다');
  });

  test('숫자만 다른 줄은 같은 사건으로 본다 — 화면의 묶어보기와 같은 기준', async () => {
    makeRule({ pattern: '느린 쿼리' });
    await watcher.sync();

    tails.feed(TARGET, [entry({ seq: 1, message: '느린 쿼리 205ms', raw: '느린 쿼리 205ms' })]);
    tails.feed(TARGET, [entry({ seq: 2, message: '느린 쿼리 998ms', raw: '느린 쿼리 998ms' })]);

    const hits = handle.db.select().from(alertHits).all();
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.count, 2);
  });

  test('다른 사건은 따로 알린다', async () => {
    makeRule({ pattern: 'Error' });
    await watcher.sync();

    tails.feed(TARGET, [entry({ seq: 1, message: 'OutOfMemoryError', raw: 'OutOfMemoryError' })]);
    tails.feed(TARGET, [entry({ seq: 2, message: 'NullPointerError', raw: 'NullPointerError' })]);

    assert.equal(handle.db.select().from(alertHits).all().length, 2);
  });

  /** 재시작하면 메모리의 쿨다운이 비어 있다. DB 를 안 보면 그때마다 알림 폭탄이 난다 */
  test('재시작해도 쿨다운이 이어진다', async () => {
    makeRule({ cooldownSec: 300 });
    await watcher.sync();
    tails.feed(TARGET, [entry()]);
    assert.equal(handle.db.select().from(alertHits).all().length, 1);

    // 프로세스가 다시 뜬 상황: 새 watcher 는 메모리가 비어 있다
    const fresh = new AlertWatcher(ctx);
    (ctx as { alerts: AlertWatcher }).alerts = fresh;
    await fresh.sync();
    tails.feed(TARGET, [entry({ seq: 99 })]);

    const hits = handle.db.select().from(alertHits).all();
    assert.equal(hits.length, 1, '재시작이 새 알림을 만들면 안 된다');
    assert.equal(hits[0]!.count, 2);
  });

  test('쿨다운이 0이면 매번 알린다', async () => {
    makeRule({ cooldownSec: 0 });
    await watcher.sync();
    tails.feed(TARGET, [entry({ seq: 1 })]);
    tails.feed(TARGET, [entry({ seq: 2 })]);
    assert.equal(handle.db.select().from(alertHits).all().length, 2);
  });
});

/**
 * 알림은 앱 밖으로 나간다 — OS 토스트는 잠금화면과 알림센터에 남고,
 * 화면을 공유하는 중에도 뜬다. '로그 본문은 메모리에만' 이 이 도구의 전제인데
 * 알림이 그 구멍이 되면 안 된다.
 *
 * 화면에서 조심하는 것으로는 부족하다. 애초에 본문이 클라이언트까지 오지 않아야 한다.
 * 그 성질을 데이터 모양으로 못 박는다.
 */
describe('알림 감시 — 본문은 나가지 않는다', () => {
  const SECRET = 'OutOfMemoryError: Java heap space';

  test('DB 에 남는 히트에 로그 본문이 없다', async () => {
    makeRule();
    await watcher.sync();
    tails.feed(TARGET, [entry({ raw: `12:00:01 *ERROR* ${SECRET}`, message: SECRET })]);

    const row = handle.db.select().from(alertHits).all()[0]!;
    const dumped = JSON.stringify(row);
    assert.ok(!dumped.includes('heap space'), `히트 행에 본문이 새어 나갔다: ${dumped}`);
    assert.ok(!dumped.includes('OutOfMemoryError'), '히트 행에 본문이 새어 나갔다');
  });

  test('화면으로 밀어주는 이벤트에도 본문이 없다', async () => {
    const events: unknown[] = [];
    watcher.subscribe((e) => events.push(e));
    makeRule();
    await watcher.sync();
    tails.feed(TARGET, [entry({ raw: `12:00:01 *ERROR* ${SECRET}`, message: SECRET })]);

    const dumped = JSON.stringify(events);
    assert.equal(events.length, 1);
    assert.ok(!dumped.includes('heap space'), `이벤트에 본문이 새어 나갔다: ${dumped}`);
  });

  /** 지문은 알림을 묶는 데만 쓴다. 숫자가 지워진 형태라 원문 복원에 쓸 수 없어야 한다 */
  test('지문에도 사람이 읽을 본문이 남지 않는다', async () => {
    makeRule({ pattern: '카드' });
    await watcher.sync();
    tails.feed(TARGET, [entry({ raw: '카드 4111111111111111 승인', message: '카드 4111111111111111 승인' })]);

    const row = handle.db.select().from(alertHits).all()[0]!;
    assert.ok(!row.signature.includes('4111111111111111'), '지문에 숫자가 그대로 남았다');
  });
});
