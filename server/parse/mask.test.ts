import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.js';
import { DEFAULT_RULES, Masker, maskEntry } from './mask.js';

const m = new Masker(true);
const mask = (s: string): string => m.mask(s)[0];
const didMask = (s: string): boolean => m.mask(s)[1];

describe('마스킹 — 가려야 하는 것', () => {
  test('Bearer 토큰', () => {
    assert.equal(
      mask('Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc'),
      'Authorization: Bearer ***',
    );
  });

  test('Basic 인증', () => {
    assert.equal(mask('Basic dXNlcjpwYXNzd29yZDEyMzQ='), 'Basic ***');
  });

  test('쿼리스트링 민감 키 — 키 이름은 남기고 값만 지운다', () => {
    assert.equal(mask('GET /api?user=kim&password=hunter2&x=1'), 'GET /api?user=kim&password=***&x=1');
    assert.equal(mask('token=abc123def'), 'token=***');
    assert.equal(mask('api_key: sk-live-9999'), 'api_key: ***');
  });

  test('이메일 — 도메인은 남긴다', () => {
    assert.equal(mask('user shin@example.com logged in'), 'user s***@example.com logged in');
  });

  test('주민등록번호', () => {
    assert.equal(mask('주민번호 850101-1234567 확인'), '주민번호 ******-******* 확인');
  });

  test('신용카드 (Luhn 통과)', () => {
    // 4111111111111111 은 표준 테스트 번호다
    assert.equal(mask('card 4111111111111111 charged'), 'card ****-****-****-1111 charged');
    assert.equal(mask('card 4111-1111-1111-1111'), 'card ****-****-****-1111');
  });

  test('masked 플래그가 선다', () => {
    assert.equal(didMask('Bearer aaaaaaaaaaaaaaaaaaaaaaa'), true);
    assert.equal(didMask('평범한 로그 한 줄'), false);
  });

  test('한 줄에 여러 개가 섞여 있어도 전부 가린다', () => {
    const out = mask('user a@b.com token=xyz789 Bearer aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(!out.includes('a@b.com'));
    assert.ok(!out.includes('xyz789'));
    assert.ok(!out.includes('aaaaaaaaaaaaaaaaaaaaaaaa'));
    assert.ok(out.includes('@b.com'), '도메인은 남아야 한다');
  });
});

/**
 * 여기가 이 파일의 핵심이다.
 * AEM 로그는 epoch ms 와 pod 이름으로 가득하다. 마스킹이 이걸 먹어버리면
 * 로그가 읽을 수 없게 되고, 그 사실을 아무도 눈치채지 못한다.
 */
describe('마스킹 — 건드리면 안 되는 것 (오탐)', () => {
  test('epoch ms 13자리를 주민번호로 오인하지 않는다', () => {
    const line = 'took 1787924224661 ms since 1698765432100';
    assert.equal(mask(line), line);
  });

  test('epoch ms 13자리를 신용카드로 오인하지 않는다', () => {
    // Luhn 을 우연히 통과하는 epoch ms
    const line = 'ts=1234567890126 done';
    assert.equal(mask(line), line);
  });

  test('aemerror 타임스탬프를 건드리지 않는다', () => {
    const line = '25.09.2023 15:34:56.428 [pod] *INFO* [thread] com.adobe.cq.Foo 메시지';
    assert.equal(mask(line), line);
  });

  test('pod 이름을 건드리지 않는다', () => {
    const line = 'cm-p33452-e121351-aem-author-54c7ddc56c-vf8vb';
    assert.equal(mask(line), line);
  });

  test('Luhn 을 통과하지 못하는 긴 숫자는 그대로 둔다', () => {
    const line = 'processed 1234567890123456 records';
    assert.equal(mask(line), line);
  });

  test('YYMMDD 로 성립하지 않는 13자리는 주민번호가 아니다', () => {
    const line = 'id 999999-1234567 raw'; // 월 99
    assert.equal(mask(line), line);
  });

  /**
   * 실물 로그에서 잡힌 오탐. JSON 소수의 소수부가 Luhn 을 통과해 카드번호로 가려졌다.
   * `"confidence":0.1234567890139730` → `"confidence":0.****-****-****-9730`
   */
  test('JSON 소수의 소수부를 카드번호로 오인하지 않는다', () => {
    const line = '{"type":"KEY_PHRASE","confidence":0.1234567890139730,"value":"edit Master text"}';
    assert.equal(mask(line), line);
  });

  test('소수·쉼표에 붙은 긴 숫자열을 건드리지 않는다', () => {
    for (const line of [
      'ratio=0.4111111111111111 done',
      'value 1.4556364187195012e-9',
      'total=12,4111111111111111',
      'x=4111111111111111.5',
    ]) {
      assert.equal(mask(line), line, `오탐: ${line}`);
    }
  });

  test('그래도 진짜 카드번호는 여전히 가린다', () => {
    assert.equal(mask('card 4111111111111111 ok'), 'card ****-****-****-1111 ok');
    assert.equal(mask('card=4111-1111-1111-1111;'), 'card=****-****-****-1111;');
    assert.equal(mask('주민번호 850101-1234567 확인'), '주민번호 ******-******* 확인');
  });

  test('경로·UUID·해시를 건드리지 않는다', () => {
    const line = '/content/dam/foo 4d2a7f3b-23e6-48d2-8b8c-dd2dc665f457 sha=9f2a1b';
    assert.equal(mask(line), line);
  });

  test('클래스명은 이메일이 아니다', () => {
    const line = 'com.adobe.cq.dam.core.impl.AssetImpl';
    assert.equal(mask(line), line);
  });
});

describe('마스킹 끄기', () => {
  test('MASKING_ENABLED=false 면 아무것도 건드리지 않는다', () => {
    const off = new Masker(false);
    const line = 'Bearer eyJhbGciOiJSUzI1NiJ9.abcdefghijklmnop user@x.com';
    assert.deepEqual(off.mask(line), [line, false]);
  });
});

describe('IP 마스킹 — prod 로그의 실사용자 주소', () => {
  test('공인 IPv4 는 /16 까지만 남긴다', () => {
    assert.equal(mask('cli_ip 180.65.167.169 KR'), 'cli_ip 180.65.*.* KR');
    assert.equal(mask('8.8.8.8'), '8.8.*.*');
  });

  /** 이 주소들은 사람이 아니라 인프라다. 가리면 로그를 못 읽는다. */
  test('사설·루프백 대역은 그대로 둔다', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.29.219.167', '192.168.45.87', '169.254.1.1']) {
      assert.equal(mask(`${ip} - GET /x`), `${ip} - GET /x`, `${ip} 를 가리면 안 된다`);
    }
  });

  test('공인 IPv6 는 앞 두 헥스텟만 남긴다', () => {
    assert.match(mask('from 2001:0db8:85a3:0000:0000:8a2e:0370:7334'), /2001:0db8:\*/);
  });

  test('IPv6 루프백·사설은 그대로 둔다', () => {
    assert.equal(mask('::1 loopback'), '::1 loopback');
    assert.equal(mask('fe80::1234:5678:9abc:def0 link'), 'fe80::1234:5678:9abc:def0 link');
  });

  test('IP 처럼 생겼지만 아닌 것을 건드리지 않는다', () => {
    for (const line of [
      'HTTP/1.1 200',
      '25.09.2023 15:34:56.428 [pod] *INFO* [t] com.x.Y m',
      'version 1.2.3.4999',
      'cm-p12345-e987654-aem-author-5fdcf57b86-j64vr',
      '999.999.999.999 invalid',
    ]) {
      assert.equal(mask(line), line, `오탐: ${line}`);
    }
  });
});

describe('maskEntry — 엔트리의 모든 문자열 필드', () => {
  const entry = (): LogEntry => ({
    seq: 0,
    ts: 0,
    level: 'INFO',
    pod: 'cm-p1-e2-aem-author-x',
    // access·cdn 파서는 클라이언트 IP 를 thread 에 넣는다
    thread: '180.65.167.169',
    logger: 'GET 200',
    message: '/content/foo.html',
    continuation: ['at 1.2.3.4'],
    raw: 'cm-p1-e2-aem-author-x 180.65.167.169 - ... "GET /content/foo.html HTTP/1.1" 200 12',
  });

  /** raw/message/continuation 만 가리면 thread 로 새 나간다. */
  test('thread 에 담긴 클라이언트 IP 도 가린다', () => {
    const out = maskEntry(entry(), new Masker(true));
    assert.equal(out.thread, '180.65.*.*');
    assert.equal(out.masked, true);
    assert.ok(!out.raw.includes('180.65.167.169'));
    assert.ok(!JSON.stringify(out).includes('180.65.167.169'), '어느 필드로도 새면 안 된다');
  });

  test('continuation 도 가린다', () => {
    const out = maskEntry(entry(), new Masker(true));
    assert.equal(out.continuation[0], 'at 1.2.*.*');
  });

  test('가릴 게 없으면 원본 객체를 그대로 돌려준다', () => {
    const e = { ...entry(), thread: 'sling-oak-observation-5', raw: '평범한 줄', message: '평범', continuation: [] };
    const out = maskEntry(e, new Masker(true));
    assert.equal(out, e, '바뀐 게 없으면 새 객체를 만들 이유가 없다');
    assert.equal(out.masked, undefined);
  });

  test('마스킹을 끄면 아무것도 안 건드린다', () => {
    const e = entry();
    assert.equal(maskEntry(e, new Masker(false)), e);
  });
});
