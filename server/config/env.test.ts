import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicOrgs } from './env.js';

const BASE: NodeJS.ProcessEnv = {
  SESSION_SECRET: 'x'.repeat(64),
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_INITIAL_PASSWORD: 'a-long-enough-password',
  ORG_1_KEY: 'acme',
  ORG_1_LABEL: 'ACME',
  ORG_1_IMS_ORG_ID: 'AAA@AdobeOrg',
  ORG_1_CLIENT_ID: 'cid',
  ORG_1_CLIENT_SECRET: 'secret',
  ORG_1_SCOPES: 'openid',
};

const withEnv = (over: NodeJS.ProcessEnv) => ({ ...BASE, ...over });

function expectFailure(env: NodeJS.ProcessEnv, ...substrings: string[]): void {
  assert.throws(
    () => loadConfig(env),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      for (const s of substrings) assert.ok(msg.includes(s), `메시지에 '${s}' 가 없다:\n${msg}`);
      return true;
    },
  );
}

describe('loadConfig', () => {
  test('기본값이 채워진다', () => {
    const cfg = loadConfig(BASE);
    assert.equal(cfg.PORT, 7300);
    assert.equal(cfg.HOST, '127.0.0.1');
    assert.equal(cfg.SESSION_TTL_HOURS, 12);
    assert.equal(cfg.MASKING_ENABLED, true);
    assert.equal(cfg.SESSION_COOKIE_SECURE, false);
  });

  test('빠진 값을 이름과 함께 알려준다', () => {
    expectFailure({}, 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_INITIAL_PASSWORD', '값이 비어 있다');
  });

  test('짧은 SESSION_SECRET 을 거부한다', () => {
    expectFailure(withEnv({ SESSION_SECRET: 'tooshort' }), 'SESSION_SECRET', '32자');
  });

  test('짧은 관리자 비밀번호를 거부한다', () => {
    expectFailure(withEnv({ ADMIN_INITIAL_PASSWORD: 'short' }), 'ADMIN_INITIAL_PASSWORD', '8자');
  });

  test('불리언과 정수를 파싱한다', () => {
    const cfg = loadConfig(withEnv({ MASKING_ENABLED: 'false', PORT: '9000', TAIL_BUFFER_MAX_LINES: '1234' }));
    assert.equal(cfg.MASKING_ENABLED, false);
    assert.equal(cfg.PORT, 9000);
    assert.equal(cfg.TAIL_BUFFER_MAX_LINES, 1234);
  });
});

describe('조직 레지스트리', () => {
  test('ORG_n_LABEL 이 비면 스캔을 멈춘다 — 3번은 무시된다', () => {
    const cfg = loadConfig(
      withEnv({
        ORG_2_LABEL: '', // 여기서 멈춘다
        ORG_3_KEY: 'ghost',
        ORG_3_LABEL: 'Ghost',
        ORG_3_IMS_ORG_ID: 'CCC@AdobeOrg',
        ORG_3_CLIENT_ID: 'c',
        ORG_3_CLIENT_SECRET: 's',
        ORG_3_SCOPES: 'openid',
      }),
    );
    assert.deepEqual([...cfg.orgs.keys()], ['acme']);
  });

  test('여러 조직을 순서대로 읽는다', () => {
    const cfg = loadConfig(
      withEnv({
        ORG_2_KEY: 'globex',
        ORG_2_LABEL: 'Globex',
        ORG_2_IMS_ORG_ID: 'BBB@AdobeOrg',
        ORG_2_CLIENT_ID: 'c2',
        ORG_2_CLIENT_SECRET: 's2',
        ORG_2_SCOPES: 'openid',
      }),
    );
    assert.deepEqual([...cfg.orgs.keys()], ['acme', 'globex']);
  });

  test('조직이 하나도 없으면 거부한다', () => {
    const { ORG_1_KEY, ORG_1_LABEL, ORG_1_IMS_ORG_ID, ORG_1_CLIENT_ID, ORG_1_CLIENT_SECRET, ORG_1_SCOPES, ...rest } = BASE;
    void [ORG_1_KEY, ORG_1_LABEL, ORG_1_IMS_ORG_ID, ORG_1_CLIENT_ID, ORG_1_CLIENT_SECRET, ORG_1_SCOPES];
    expectFailure(rest, '조직이 하나도 등록되지 않았다');
  });

  test('잘못된 org key 형태를 거부한다', () => {
    expectFailure(withEnv({ ORG_1_KEY: 'ACME Corp' }), 'ORG_1_KEY', '소문자');
  });

  test('@AdobeOrg 로 끝나지 않는 IMS org id 를 거부한다', () => {
    expectFailure(withEnv({ ORG_1_IMS_ORG_ID: 'AAA' }), 'ORG_1_IMS_ORG_ID', '@AdobeOrg');
  });

  test('빠진 client secret 을 변수 이름으로 지목한다', () => {
    expectFailure(withEnv({ ORG_1_CLIENT_SECRET: '' }), 'ORG_1_CLIENT_SECRET');
  });

  test('중복 org key 를 거부한다', () => {
    expectFailure(
      withEnv({
        ORG_2_KEY: 'acme',
        ORG_2_LABEL: 'ACME 둘',
        ORG_2_IMS_ORG_ID: 'BBB@AdobeOrg',
        ORG_2_CLIENT_ID: 'c2',
        ORG_2_CLIENT_SECRET: 's2',
        ORG_2_SCOPES: 'openid',
      }),
      '중복',
    );
  });

  test('publicOrgs 는 key 와 label 만 내놓는다 — secret 이 새면 안 된다', () => {
    const cfg = loadConfig(BASE);
    const pub = publicOrgs(cfg);
    assert.deepEqual(pub, [{ key: 'acme', label: 'ACME' }]);
    const json = JSON.stringify(pub);
    assert.ok(!json.includes('secret'));
    assert.ok(!json.includes('AdobeOrg'));
    assert.ok(!json.includes('cid'));
  });
});

describe('scope 정규화', () => {
  test('Developer Console 이 보여주는 콤마+공백 형태를 그대로 붙여넣어도 된다', () => {
    const cfg = loadConfig(
      withEnv({ ORG_1_SCOPES: 'openid, AdobeID, read_organizations, additional_info.projectedProductContext' }),
    );
    assert.equal(
      cfg.orgs.get('acme')?.scopes,
      'openid,AdobeID,read_organizations,additional_info.projectedProductContext',
    );
  });

  test('줄바꿈과 후행 콤마도 털어낸다', () => {
    const cfg = loadConfig(withEnv({ ORG_1_SCOPES: 'openid,\tAdobeID , , read_organizations,' }));
    assert.equal(cfg.orgs.get('acme')?.scopes, 'openid,AdobeID,read_organizations');
  });

  test('공백뿐인 scope 는 거부한다', () => {
    expectFailure(withEnv({ ORG_1_SCOPES: ' , , ' }), 'ORG_1_SCOPES');
  });
});
