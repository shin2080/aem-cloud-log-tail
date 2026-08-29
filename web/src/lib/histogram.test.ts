import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry, LogLevel } from '../../../shared/types.js';
import { buildHistogram, bucketWidthMs } from './histogram.js';

let seq = 0;
const at = (iso: string, level: LogLevel = 'INFO'): LogEntry => ({
  seq: seq++,
  ts: Date.parse(`2026-08-29T${iso}Z`),
  level,
  pod: '',
  thread: '',
  logger: '',
  message: '',
  continuation: [],
  raw: '',
});

describe('buildHistogram', () => {
  test('레벨별로 센다', () => {
    const b = buildHistogram([at('00:00:00', 'ERROR'), at('00:00:01', 'WARN'), at('00:00:02', 'INFO')], 1);
    const total = b.reduce((s, x) => s + x.error + x.warn + x.other, 0);
    assert.equal(total, 3);
    assert.equal(b.reduce((s, x) => s + x.error, 0), 1);
    assert.equal(b.reduce((s, x) => s + x.warn, 0), 1);
    assert.equal(b.reduce((s, x) => s + x.other, 0), 1);
  });

  test('모든 엔트리가 어느 버킷엔가 들어간다 — 세다가 흘리면 안 된다', () => {
    const entries = Array.from({ length: 500 }, (_, i) =>
      at(`0${Math.floor(i / 600)}:${String(Math.floor(i / 10) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`),
    );
    const b = buildHistogram(entries);
    assert.equal(b.reduce((s, x) => s + x.error + x.warn + x.other, 0), entries.length);
  });

  test('버킷 수가 과하게 늘지 않는다', () => {
    const entries = [at('00:00:00'), at('23:59:59')];
    const b = buildHistogram(entries, 60);
    assert.ok(b.length <= 120, `버킷이 ${b.length}개나 된다`);
  });

  test('버킷 폭은 최소 1초다', () => {
    const b = buildHistogram([at('00:00:00'), at('00:00:00')], 60);
    assert.ok(bucketWidthMs(b) >= 1000);
  });

  test('빈 입력에 던지지 않는다', () => {
    assert.deepEqual(buildHistogram([]), []);
  });

  test('한 건만 있어도 동작한다', () => {
    const b = buildHistogram([at('12:00:00', 'ERROR')]);
    assert.equal(b.length, 1);
    assert.equal(b[0]!.error, 1);
  });
});
