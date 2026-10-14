import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.js';
import { createParser, hasParser } from './parser.js';
import './register.js';
import { parseClfTime, levelFromStatus } from './lineparser.js';

/**
 * 아래 라인들은 전부 실환경(acme/dev)에서 그대로 뽑은 것이다.
 * 형식을 상상해서 쓰면 실물과 어긋나므로 표본을 박아둔다.
 */
const POD = 'cm-p12345-e987654-aem-author-5fdcf57b86-j64vr';

function parse(logName: string, text: string): LogEntry[] {
  const p = createParser(logName, 0);
  const m = new Map<number, LogEntry>();
  for (const e of [...p.push(text), ...p.flush()]) m.set(e.seq, e);
  return [...m.values()];
}

const iso = (e: LogEntry): string => new Date(e.ts).toISOString();

describe('parseClfTime', () => {
  test('CLF 시각을 UTC 로 읽는다', () => {
    assert.equal(new Date(parseClfTime('29/Aug/2026:00:58:48 +0000')!).toISOString(), '2026-08-29T00:58:48.000Z');
  });

  test('오프셋을 반영한다', () => {
    assert.equal(new Date(parseClfTime('29/Aug/2026:09:58:48 +0900')!).toISOString(), '2026-08-29T00:58:48.000Z');
  });

  test('오프셋이 없어도 읽는다 (UTC 로 본다)', () => {
    assert.equal(new Date(parseClfTime('29/Aug/2026:00:58:48')!).toISOString(), '2026-08-29T00:58:48.000Z');
  });

  test('형식이 다르면 null', () => {
    assert.equal(parseClfTime('2026-08-29T00:58:48Z'), null);
    assert.equal(parseClfTime('29/Xxx/2026:00:58:48 +0000'), null);
  });
});

describe('levelFromStatus — access 로그의 레벨은 상태코드에서 온다', () => {
  test('5xx 는 ERROR, 4xx 는 WARN, 나머지는 INFO', () => {
    assert.equal(levelFromStatus(500), 'ERROR');
    assert.equal(levelFromStatus(503), 'ERROR');
    assert.equal(levelFromStatus(404), 'WARN');
    assert.equal(levelFromStatus(403), 'WARN');
    assert.equal(levelFromStatus(200), 'INFO');
    assert.equal(levelFromStatus(301), 'INFO');
  });
});

describe('aemaccess / httpdaccess', () => {
  const short = `${POD} 127.0.0.1 - 29/Aug/2026:00:58:48 +0000 "HEAD /libs/granite/core/content/login.html HTTP/1.1" 200 13425 `;
  const long = `${POD} ::1 - 29/Aug/2026:00:58:57 +0000 "POST /dispatcher/invalidate.cache HTTP/1.1" 200 13 "-" "python-requests/2.31.0"`;

  test('referer/UA 가 없는 형태를 읽는다', () => {
    const [e] = parse('aemaccess', short + '\n');
    assert.ok(e);
    assert.equal(iso(e), '2026-08-29T00:58:48.000Z');
    assert.equal(e.level, 'INFO');
    assert.equal(e.pod, POD);
    assert.equal(e.thread, '127.0.0.1');
    assert.equal(e.logger, 'HEAD 200');
    assert.match(e.message, /^\/libs\/granite\/core\/content\/login\.html/);
    assert.match(e.message, /13425B/);
  });

  test('referer/UA 가 있는 형태를 읽는다', () => {
    const [e] = parse('httpdaccess', long + '\n');
    assert.ok(e);
    assert.equal(e.logger, 'POST 200');
    assert.match(e.message, /ua=python-requests/);
  });

  /** 이 매핑이 있어야 뷰어에서 'ERROR 만 보기' 가 5xx 만 보기가 된다. */
  test('5xx 는 ERROR 로, 4xx 는 WARN 으로 올라온다', () => {
    const err = `${POD} 1.2.3.4 - 29/Aug/2026:00:58:48 +0000 "GET /boom HTTP/1.1" 500 12`;
    const warn = `${POD} 1.2.3.4 - 29/Aug/2026:00:58:48 +0000 "GET /nope HTTP/1.1" 404 12`;
    assert.equal(parse('aemaccess', err + '\n')[0]!.level, 'ERROR');
    assert.equal(parse('aemaccess', warn + '\n')[0]!.level, 'WARN');
  });

  test("바이트 수가 '-' 여도 견딘다", () => {
    const line = `${POD} 127.0.0.1 - 29/Aug/2026:01:00:37 +0000 "HEAD /libs/granite/security/currentuser.json HTTP/1.1" 200 - "-" "Java/21.0.11"`;
    const [e] = parse('aemaccess', line + '\n');
    assert.ok(e);
    assert.equal(e.level, 'INFO');
    assert.ok(!e.message.includes('-B'));
  });

  /** 한 줄이 한 엔트리다. 못 읽은 줄이 앞 엔트리에 붙으면 안 된다. */
  test('형식이 깨진 줄을 앞 엔트리의 continuation 으로 붙이지 않는다', () => {
    const out = parse('aemaccess', short + '\n' + '이건 access 로그가 아니다\n');
    assert.equal(out.length, 2);
    assert.deepEqual(out[0]!.continuation, []);
    assert.equal(out[1]!.level, 'UNKNOWN');
  });
});

describe('aemrequest', () => {
  const pair =
    '29/Aug/2026:01:01:53 +0000 [8072] -> HEAD /libs/granite/core/content/login.html HTTP/1.1 [' + POD + ']\n' +
    '29/Aug/2026:01:01:53 +0000 [8072] <- 200 text/html;charset=utf-8 12ms [' + POD + ']\n';

  test('요청·응답 두 줄을 각각 엔트리로 낸다', () => {
    const out = parse('aemrequest', pair);
    assert.equal(out.length, 2);
    assert.equal(out[0]!.thread, '8072');
    assert.equal(out[1]!.thread, '8072');
  });

  test('응답 줄에 요청 경로를 합쳐 보여준다', () => {
    const out = parse('aemrequest', pair);
    assert.match(out[1]!.message, /12ms/);
    assert.match(out[1]!.message, /HEAD \/libs\/granite\/core\/content\/login\.html/);
    assert.equal(out[1]!.logger, 'HEAD 200');
  });

  /** 버퍼 앞이 잘려 요청 줄을 못 본 경우. 조용히 버리지 않는다. */
  test('요청 줄이 없으면 그렇다고 표시한다', () => {
    const out = parse('aemrequest', '29/Aug/2026:01:02:53 +0000 [2868] <- 200 application/json 5ms [' + POD + ']\n');
    assert.equal(out.length, 1);
    assert.match(out[0]!.message, /요청 줄 없음/);
  });

  /** 느린 요청은 200 이어도 눈에 띄어야 한다. */
  test('소요시간으로 레벨을 올린다', () => {
    const slow = (ms: number) =>
      parse('aemrequest', `29/Aug/2026:01:01:53 +0000 [1] <- 200 text/html ${ms}ms [${POD}]\n`)[0]!.level;
    assert.equal(slow(12), 'INFO');
    assert.equal(slow(1500), 'WARN');
    assert.equal(slow(6000), 'ERROR');
  });

  test('상태코드와 소요시간 중 더 나쁜 쪽을 쓴다', () => {
    const e = parse('aemrequest', `29/Aug/2026:01:01:53 +0000 [1] <- 500 text/html 5ms [${POD}]\n`)[0]!;
    assert.equal(e.level, 'ERROR');
  });
});

describe('aemdispatcher', () => {
  const line =
    '[29/Aug/2026:01:01:57 +0000] [I] [cm-p12345-e987654-aem-publish-5cd4774d9-x8m4q] "POST /dispatcher/invalidate.cache" 200 0ms [publishfarm/-] [actionpurge]';

  test('실환경 라인을 읽는다', () => {
    const [e] = parse('aemdispatcher', line + '\n');
    assert.ok(e);
    assert.equal(iso(e), '2026-08-29T01:01:57.000Z');
    assert.equal(e.level, 'INFO');
    assert.equal(e.logger, 'POST 200');
    assert.match(e.message, /invalidate\.cache/);
    assert.match(e.message, /0ms/);
  });

  test('레벨 문자를 옮긴다', () => {
    const mk = (l: string) => `[29/Aug/2026:01:01:57 +0000] [${l}] [pod] "GET /x" 200 1ms`;
    assert.equal(parse('aemdispatcher', mk('E') + '\n')[0]!.level, 'ERROR');
    assert.equal(parse('aemdispatcher', mk('W') + '\n')[0]!.level, 'WARN');
    assert.equal(parse('aemdispatcher', mk('D') + '\n')[0]!.level, 'DEBUG');
  });

  /** 디스패처가 I 로 찍어도 5xx 면 놓치면 안 된다. */
  test('상태코드가 더 나쁘면 레벨을 올린다', () => {
    const e = parse('aemdispatcher', '[29/Aug/2026:01:01:57 +0000] [I] [pod] "GET /x" 503 1ms\n')[0]!;
    assert.equal(e.level, 'ERROR');
    const w = parse('aemdispatcher', '[29/Aug/2026:01:01:57 +0000] [I] [pod] "GET /x" 404 1ms\n')[0]!;
    assert.equal(w.level, 'WARN');
  });

  /** 반대 방향으로는 올리지 않는다. 200 이라고 DEBUG 를 INFO 로 만들면 필터가 망가진다. */
  test('상태가 정상이면 선언된 레벨을 그대로 둔다', () => {
    const e = parse('aemdispatcher', '[29/Aug/2026:01:01:57 +0000] [D] [pod] "GET /x" 200 1ms\n')[0]!;
    assert.equal(e.level, 'DEBUG');
  });
});

describe('httpderror', () => {
  const line =
    'Sat Aug 29 01:01:48.407729 2026 [managed_rewrite_maps:debug] [pid 118] [cm-p12345-e987654-aem-publish-5cd4774d9-x8m4q] Managed rewrite maps check DONE';

  test('Apache 에러 로그를 읽는다', () => {
    const [e] = parse('httpderror', line + '\n');
    assert.ok(e);
    assert.equal(iso(e), '2026-08-29T01:01:48.407Z');
    assert.equal(e.level, 'DEBUG');
    assert.equal(e.logger, 'managed_rewrite_maps');
    assert.equal(e.thread, 'pid 118');
    assert.equal(e.message, 'Managed rewrite maps check DONE');
  });

  test('Apache 레벨 이름을 옮긴다', () => {
    const mk = (l: string) => `Sat Aug 29 01:01:48.407729 2026 [core:${l}] [pid 1] [pod] msg`;
    assert.equal(parse('httpderror', mk('error') + '\n')[0]!.level, 'ERROR');
    assert.equal(parse('httpderror', mk('crit') + '\n')[0]!.level, 'ERROR');
    assert.equal(parse('httpderror', mk('warn') + '\n')[0]!.level, 'WARN');
    assert.equal(parse('httpderror', mk('notice') + '\n')[0]!.level, 'INFO');
  });

  test('여러 줄에 걸친 메시지를 묶는다', () => {
    const out = parse('httpderror', line + '\n' + '  계속되는 줄\n');
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.continuation, ['  계속되는 줄']);
  });
});

describe('cdn', () => {
  const rec = {
    timestamp: '2026-08-29T00:58:34+0000',
    ttfb: 42,
    ttlb: 78,
    cli_ip: '180.65.167.169',
    cli_country: 'KR',
    status: 200,
    method: 'GET',
    url: '/content/foo.html',
    cache: 'HIT',
  };

  test('JSON 라인을 읽는다', () => {
    const [e] = parse('cdn', JSON.stringify(rec) + '\n');
    assert.ok(e);
    assert.equal(iso(e), '2026-08-29T00:58:34.000Z');
    assert.equal(e.level, 'INFO');
    assert.equal(e.thread, '180.65.167.169');
    assert.equal(e.logger, 'GET 200');
    assert.match(e.message, /\/content\/foo\.html/);
    assert.match(e.message, /78ms/);
    assert.match(e.message, /cache=HIT/);
  });

  /** '+0000' 은 콜론이 없어 Date.parse 가 못 읽는다. */
  test('콜론 없는 오프셋을 처리한다', () => {
    const [e] = parse('cdn', JSON.stringify({ ...rec, timestamp: '2026-08-29T09:58:34+0900' }) + '\n');
    assert.equal(iso(e!), '2026-08-29T00:58:34.000Z');
  });

  test('5xx 를 ERROR 로 올린다', () => {
    assert.equal(parse('cdn', JSON.stringify({ ...rec, status: 502 }) + '\n')[0]!.level, 'ERROR');
  });

  test('아는 필드가 없으면 원본을 그대로 보여준다', () => {
    const [e] = parse('cdn', JSON.stringify({ timestamp: rec.timestamp, weird: 1 }) + '\n');
    assert.ok(e!.message.includes('weird'));
  });

  test('깨진 JSON 에 던지지 않는다', () => {
    const out = parse('cdn', '{not json\n');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.level, 'UNKNOWN');
  });
});

describe('레지스트리', () => {
  test('이 환경에 있는 로그 종류가 전부 등록돼 있다', () => {
    for (const n of ['aemerror', 'aemaccess', 'aemrequest', 'cdn', 'aemdispatcher', 'httpdaccess', 'httpderror']) {
      assert.equal(hasParser(n), true, `${n} 파서가 없다`);
    }
  });

  test('모르는 로그는 명확히 거부한다', () => {
    assert.equal(hasParser('nosuchlog'), false);
    assert.throws(() => createParser('nosuchlog'), /파서가 없다/);
  });

  /** 청크 경계 처리는 기반 클래스에 한 번만 있다. 종류별로 다시 확인한다. */
  test('모든 파서가 한 바이트씩 넣어도 같은 결과를 낸다', () => {
    const samples: [string, string][] = [
      ['aemaccess', `${POD} 127.0.0.1 - 29/Aug/2026:00:58:48 +0000 "GET /a HTTP/1.1" 200 1\n`],
      ['aemrequest', `29/Aug/2026:01:01:53 +0000 [1] <- 200 text/html 12ms [${POD}]\n`],
      ['aemdispatcher', '[29/Aug/2026:01:01:57 +0000] [I] [pod] "GET /x" 200 1ms\n'],
      ['httpderror', 'Sat Aug 29 01:01:48.407729 2026 [core:error] [pid 1] [pod] boom\n'],
      ['cdn', '{"timestamp":"2026-08-29T00:58:34+0000","status":200,"method":"GET","url":"/a"}\n'],
    ];

    for (const [name, text] of samples) {
      const whole = parse(name, text);
      const p = createParser(name, 0);
      const m = new Map<number, LogEntry>();
      for (const ch of text) for (const e of p.push(ch)) m.set(e.seq, e);
      for (const e of p.flush()) m.set(e.seq, e);
      assert.deepEqual([...m.values()], whole, `${name}: 한 바이트씩 넣으면 결과가 달라진다`);
    }
  });
});

describe('잘린 선두 조각의 시각', () => {
  test('다음 정상 줄의 시각을 물려받는다 — Date.now() 가 아니다', async () => {
    const { createParser } = await import('./parser.js');
    await import('./register.js');
    const p = createParser('aemaccess', 0);
    const before = Date.now();
    const first = p.push('P/1.1" 200 13\n');
    assert.equal(first.length, 1);
    assert.ok(first[0]!.ts < before - 365 * 24 * 3600_000, '선두 조각에 현재 시각이 박히면 시각 이동이 늘 여기 걸린다');

    const next = p.push('cm-p1-e2-aem-author-x 127.0.0.1 - 29/Aug/2026:00:58:48 +0000 "GET /a HTTP/1.1" 200 1\n');
    const orphan = next.find((e) => e.seq === 0);
    const real = next.find((e) => e.seq === 1)!;
    assert.ok(orphan, '시각이 바뀐 조각은 다시 내보내야 화면이 고친다');
    assert.equal(orphan!.ts, real.ts);
  });
});
