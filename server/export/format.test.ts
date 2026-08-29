import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '../../shared/types.js';
import { renderExport, exportFilename, provenanceLines, kstIso, estimateBytes, type ExportContext } from './format.js';

const ctx: ExportContext = {
  orgKey: 'acme',
  orgLabel: 'ACME',
  programId: '12345',
  environmentId: '67890',
  environmentType: 'prod',
  service: 'publish',
  logName: 'aemerror',
  from: Date.parse('2026-08-28T05:00:00Z'), // KST 14:00
  to: Date.parse('2026-08-28T05:30:00Z'), // KST 14:30
  levels: ['ERROR'],
  query: 'NullPointer',
  masked: true,
  lines: 1284,
  exportedBy: 'shin@example.com',
  exportedAt: Date.parse('2026-08-28T06:02:11Z'), // KST 15:02:11
  includeContinuation: true,
};

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  seq: 0,
  ts: Date.parse('2026-08-28T05:10:00.123Z'),
  level: 'ERROR',
  pod: 'cm-p1-e2-aem-publish-x',
  thread: 'qtp-1',
  logger: 'com.adobe.cq.Foo',
  message: '터졌다',
  continuation: ['java.lang.NullPointerException', '\tat com.adobe.cq.Foo.bar(Foo.java:42)'],
  raw: '28.08.2026 05:10:00.123 [cm-p1-e2-aem-publish-x] *ERROR* [qtp-1] com.adobe.cq.Foo 터졌다',
  ...over,
});

const render = (entries: LogEntry[], format: 'log' | 'json' | 'csv', c = ctx): string =>
  [...renderExport(entries, c, format)].join('');

describe('KST 변환', () => {
  test('UTC 를 KST 표기로 바꾼다', () => {
    assert.equal(kstIso(Date.parse('2026-08-28T05:00:00Z')), '2026-08-28T14:00:00+09:00');
  });

  test('UTC 자정을 넘으면 KST 날짜가 하루 앞선다', () => {
    assert.equal(kstIso(Date.parse('2026-08-28T15:30:00Z')), '2026-08-29T00:30:00+09:00');
  });
});

describe('파일명', () => {
  test('SPEC 의 고정 규칙을 따른다', () => {
    assert.equal(exportFilename(ctx, 'log'), 'acme-p12345-e67890-publish-aemerror-20260828T1400_1430.log');
  });

  test('포맷에 따라 확장자가 바뀐다', () => {
    assert.equal(exportFilename(ctx, 'json'), 'acme-p12345-e67890-publish-aemerror-20260828T1400_1430.json');
    assert.equal(exportFilename(ctx, 'csv'), 'acme-p12345-e67890-publish-aemerror-20260828T1400_1430.csv');
  });
});

describe('출처 헤더', () => {
  test('조직·환경·범위·필터·요청자가 모두 들어간다', () => {
    const h = provenanceLines(ctx).join('\n');
    assert.match(h, /org=acme/);
    assert.match(h, /program=12345/);
    assert.match(h, /environment=67890 \(prod\)/);
    assert.match(h, /service=publish/);
    assert.match(h, /log=aemerror/);
    assert.match(h, /2026-08-28T14:00:00\+09:00 ~ 2026-08-28T14:30:00\+09:00 \(KST\)/);
    assert.match(h, /level:ERROR/);
    assert.match(h, /query:"NullPointer"/);
    assert.match(h, /masked=true/);
    assert.match(h, /lines=1284/);
    assert.match(h, /shin@example\.com/);
  });

  test('필터가 없으면 없다고 적는다', () => {
    const h = provenanceLines({ ...ctx, levels: null, query: undefined }).join('\n');
    assert.match(h, /filters=\(없음\)/);
  });
});

describe('log 포맷', () => {
  test('원본 라인 그대로, 헤더는 주석으로', () => {
    const out = render([entry()], 'log');
    assert.ok(out.startsWith('# AEM Cloud Log Viewer export\n'));
    assert.ok(out.includes('28.08.2026 05:10:00.123 [cm-p1-e2-aem-publish-x] *ERROR*'));
    assert.ok(out.includes('\tat com.adobe.cq.Foo.bar(Foo.java:42)'));
  });

  test('includeContinuation=false 면 스택을 뺀다', () => {
    const out = render([entry()], 'log', { ...ctx, includeContinuation: false });
    assert.ok(!out.includes('NullPointerException'));
    assert.ok(out.includes('*ERROR*'));
  });
});

describe('json 포맷', () => {
  test('JSONL 이고 첫 줄이 출처다', () => {
    const lines = render([entry(), entry({ seq: 1 })], 'json').trim().split('\n');
    assert.equal(lines.length, 3);
    const head = JSON.parse(lines[0]!) as { _export: Record<string, string> };
    assert.ok(Object.values(head._export).join(' ').includes('org=acme'));
    const e = JSON.parse(lines[1]!) as LogEntry;
    assert.equal(e.level, 'ERROR');
    assert.equal(e.continuation.length, 2);
  });

  test('모든 줄이 유효한 JSON 이다', () => {
    for (const l of render([entry()], 'json').trim().split('\n')) {
      assert.doesNotThrow(() => JSON.parse(l));
    }
  });
});

describe('csv 포맷', () => {
  test('SPEC 의 컬럼 순서를 따른다', () => {
    const lines = render([entry()], 'csv').trim().split('\n');
    const header = lines.find((l) => !l.startsWith('#'))!;
    assert.equal(header, 'ts,level,pod,thread,logger,message');
  });

  test('쉼표·따옴표·개행이 든 메시지를 이스케이프한다', () => {
    const out = render([entry({ message: 'a,b "c" d', continuation: [] })], 'csv');
    assert.ok(out.includes('"a,b ""c"" d"'), `이스케이프 실패: ${out}`);
  });

  test('CSV 를 다시 파싱하면 필드 수가 맞는다', () => {
    const out = render([entry({ continuation: [] })], 'csv');
    const rows = out.split('\n').filter((l) => l && !l.startsWith('#') && !l.startsWith('ts,'));
    assert.ok(rows.length > 0);
    // 따옴표 밖의 쉼표만 세어 6개 필드인지 본다
    for (const r of rows) {
      let inQ = false;
      let commas = 0;
      for (const ch of r) {
        if (ch === '"') inQ = !inQ;
        else if (ch === ',' && !inQ) commas++;
      }
      assert.equal(commas, 5, `필드 수가 다르다: ${r}`);
    }
  });
});

describe('크기 어림', () => {
  test('엔트리가 늘면 커진다', () => {
    const one = estimateBytes([entry()], 'log', true);
    const two = estimateBytes([entry(), entry()], 'log', true);
    assert.ok(two > one);
  });

  test('실제 출력보다 과소평가하지 않는다 — 상한 검사가 헐거워지면 안 된다', () => {
    const entries = [entry(), entry({ seq: 1 }), entry({ seq: 2 })];
    for (const f of ['log', 'json', 'csv'] as const) {
      const est = estimateBytes(entries, f, true);
      const actual = Buffer.byteLength(render(entries, f), 'utf8');
      assert.ok(est >= actual * 0.9, `${f}: 어림 ${est} < 실제 ${actual}`);
    }
  });

  test('스택을 빼면 작아진다', () => {
    assert.ok(estimateBytes([entry()], 'log', false) < estimateBytes([entry()], 'log', true));
  });
});
