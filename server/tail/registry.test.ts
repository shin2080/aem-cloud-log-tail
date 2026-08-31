import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type AppConfig, type OrgConfig } from '../config/env.js';
import { CloudManagerClient } from '../adobe/cloudmanager.js';
import { ImsTokenCache } from '../adobe/ims.js';
import '../parse/register.js';
import { TailRegistry } from './registry.js';
import type { RangeRead, ResolvedTail, TailTransport } from './transport.js';
import type { TailKey } from './session.js';

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
  TAIL_IDLE_TIMEOUT_MS: '1000',
  TAIL_POLL_INTERVAL_MS: '1000000', // 테스트 중 실제 폴링이 돌지 않게
};

/** 몇 번 만들어졌는지 세는 가짜 transport */
class CountingTransport implements TailTransport {
  static created = 0;
  private text = '';

  constructor() {
    CountingTransport.created++;
  }
  async resolveTail(d: string): Promise<ResolvedTail> {
    return { date: d, url: `https://blob.test/${d}.log` };
  }
  async sizeOf(): Promise<number> {
    return Buffer.byteLength(this.text, 'utf8');
  }
  async readFrom(_url: string, offset: number): Promise<RangeRead> {
    const buf = Buffer.from(this.text, 'utf8');
    if (offset >= buf.byteLength) return { status: 416, bytes: new Uint8Array(0), totalSize: buf.byteLength };
    return { status: 206, bytes: new Uint8Array(buf.subarray(offset)), totalSize: buf.byteLength };
  }
}

let cfg: AppConfig;
let org: OrgConfig;
let reg: TailRegistry;

const KEY: TailKey = { orgKey: 'acme', environmentId: '987654', service: 'author', logName: 'aemerror' };
const KEY2: TailKey = { ...KEY, service: 'publish' };

beforeEach(() => {
  cfg = loadConfig(ENV);
  org = cfg.orgs.get('acme')!;
  CountingTransport.created = 0;
  reg = new TailRegistry(cfg, new CloudManagerClient(new ImsTokenCache()), () => new CountingTransport());
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('TailRegistry — 세션 공유', () => {
  /** 같은 환경을 두 명이 봐도 폴링 루프는 하나여야 한다. */
  test('같은 대상은 세션을 공유한다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    const b = await reg.subscribe(KEY, org, '1', () => {});

    assert.equal(CountingTransport.created, 1, '폴링 루프가 둘이면 Azure 요청이 두 배가 된다');
    assert.equal(a.session, b.session);
    assert.equal(a.session.subscriberCount, 2);
    assert.equal(reg.activeCount, 1);
  });

  test('다른 대상은 따로 만든다', async () => {
    await reg.subscribe(KEY, org, '1', () => {});
    await reg.subscribe(KEY2, org, '1', () => {});
    assert.equal(reg.activeCount, 2);
    assert.equal(CountingTransport.created, 2);
  });

  test('peek 은 있는 세션만 준다', async () => {
    assert.equal(reg.peek(KEY), undefined);
    await reg.subscribe(KEY, org, '1', () => {});
    assert.ok(reg.peek(KEY));
    assert.equal(reg.peek(KEY2), undefined);
  });
});

describe('TailRegistry — 유휴 정리', () => {
  test('구독자가 남아 있으면 살려둔다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    await reg.subscribe(KEY, org, '1', () => {});

    a.unsubscribe();
    await sleep(1300); // 유휴 시간을 넘긴다

    assert.equal(reg.activeCount, 1, '아직 보는 사람이 있는데 끊으면 안 된다');
    assert.equal(reg.peek(KEY)?.subscriberCount, 1);
  });

  /** 이걸 놓치면 폴링 루프가 영원히 돈다. */
  test('마지막 구독자가 떠나고 유휴 시간이 지나면 정리한다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    a.unsubscribe();

    assert.equal(reg.activeCount, 1, '떠나자마자 죽이지는 않는다 (새로고침 대비)');
    await sleep(1300);
    assert.equal(reg.activeCount, 0, '유휴 시간이 지나면 루프를 멈춰야 한다');
  });

  test('유휴 시간 안에 다시 붙으면 정리를 취소한다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    a.unsubscribe();
    await sleep(300);

    const b = await reg.subscribe(KEY, org, '1', () => {});
    await sleep(1300);

    assert.equal(reg.activeCount, 1, '다시 붙었는데 예약된 정리가 실행되면 안 된다');
    assert.equal(b.session.subscriberCount, 1);
    assert.equal(CountingTransport.created, 1, '세션을 다시 만들지도 않아야 한다');
  });

  test('정리된 뒤 다시 붙으면 새로 만든다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    a.unsubscribe();
    await sleep(1300);

    await reg.subscribe(KEY, org, '1', () => {});
    assert.equal(reg.activeCount, 1);
    assert.equal(CountingTransport.created, 2);
  });

  /**
   * 새 세션은 seq 가 0부터 다시 시작한다. 클라이언트가 그걸 알아채지 못하면
   * 새 엔트리를 전부 조용히 버려서, 화면은 '연결됨' 인데 로그만 안 늘어난다.
   * 세대가 실제로 달라지는지는 여기서 못 박아둔다.
   */
  test('다시 만들어진 세션은 세대가 다르다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    const first = a.session.generation;
    a.unsubscribe();
    await sleep(1300);

    const b = await reg.subscribe(KEY, org, '1', () => {});
    assert.notEqual(b.session.generation, first);
  });

  test('같은 세션을 공유하면 세대도 같다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    const b = await reg.subscribe(KEY, org, '1', () => {});
    assert.equal(a.session.generation, b.session.generation);
  });
});

describe('TailRegistry — 실패와 종료', () => {
  /** 죽은 세션을 남겨두면 다음 요청이 그걸 잡는다. */
  test('start 가 실패하면 레지스트리에 남기지 않는다', async () => {
    const bad = new TailRegistry(cfg, new CloudManagerClient(new ImsTokenCache()), () => ({
      resolveTail: async () => {
        throw new Error('tail 링크 없음');
      },
      sizeOf: async () => 0,
      readFrom: async () => ({ status: 416, bytes: new Uint8Array(0), totalSize: 0 }),
    }));

    await assert.rejects(() => bad.subscribe(KEY, org, '1', () => {}));
    assert.equal(bad.activeCount, 0, '죽은 세션이 남으면 다음 요청이 그걸 잡는다');
  });

  test('stopAll 은 모든 세션을 정리한다', async () => {
    await reg.subscribe(KEY, org, '1', () => {});
    await reg.subscribe(KEY2, org, '1', () => {});
    assert.equal(reg.activeCount, 2);

    reg.stopAll();
    assert.equal(reg.activeCount, 0);
  });

  test('같은 구독을 두 번 해지해도 터지지 않는다', async () => {
    const a = await reg.subscribe(KEY, org, '1', () => {});
    a.unsubscribe();
    assert.doesNotThrow(() => a.unsubscribe());
  });
});
