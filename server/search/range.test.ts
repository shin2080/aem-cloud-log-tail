import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { utcDatesInRange, isWithinRetention, splitRetained, utcDate } from './range.js';

const KST = (s: string) => Date.parse(`${s}+09:00`);
const UTC = (s: string) => Date.parse(`${s}Z`);

describe('utcDatesInRange — KST 로 고른 구간이 어느 UTC 파일에 있는가', () => {
  /** SPEC 7장의 예시 그대로 */
  test('KST 8/28 14:00~15:00 → UTC 8/28 05:00~06:00 → 당일 파일 하나', () => {
    assert.deepEqual(utcDatesInRange(KST('2026-08-28T14:00:00'), KST('2026-08-28T15:00:00')), ['2026-08-28']);
  });

  /** 여기가 핵심. KST 새벽은 UTC 로 전날이다. */
  test('KST 8/29 02:00~05:00 → UTC 8/28 17:00~20:00 → **전날** 파일만 읽는다', () => {
    const dates = utcDatesInRange(KST('2026-08-29T02:00:00'), KST('2026-08-29T05:00:00'));
    assert.deepEqual(dates, ['2026-08-28'], 'KST 새벽인데 8/29 파일을 읽으면 결과가 빈다');
  });

  test('KST 8/29 08:00~10:00 → UTC 자정을 걸쳐 두 파일', () => {
    assert.deepEqual(utcDatesInRange(KST('2026-08-29T08:00:00'), KST('2026-08-29T10:00:00')), [
      '2026-08-28',
      '2026-08-29',
    ]);
  });

  test('KST 하루 전체(00:00~24:00)는 UTC 파일 두 개에 걸친다', () => {
    assert.deepEqual(utcDatesInRange(KST('2026-08-29T00:00:00'), KST('2026-08-29T23:59:59')), [
      '2026-08-28',
      '2026-08-29',
    ]);
  });

  test('KST 오전 9시 정각이 경계다', () => {
    assert.deepEqual(utcDatesInRange(KST('2026-08-29T08:59:59'), KST('2026-08-29T08:59:59')), ['2026-08-28']);
    assert.deepEqual(utcDatesInRange(KST('2026-08-29T09:00:00'), KST('2026-08-29T09:00:00')), ['2026-08-29']);
  });
});

describe('utcDatesInRange — 일반', () => {
  test('같은 시각이면 하루', () => {
    assert.deepEqual(utcDatesInRange(UTC('2026-08-28T12:00:00'), UTC('2026-08-28T12:00:00')), ['2026-08-28']);
  });

  test('여러 날에 걸치면 빠짐없이 연속으로 준다', () => {
    assert.deepEqual(utcDatesInRange(UTC('2026-08-26T23:00:00'), UTC('2026-08-29T01:00:00')), [
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
      '2026-08-29',
    ]);
  });

  test('월 경계를 넘어간다', () => {
    assert.deepEqual(utcDatesInRange(UTC('2026-08-31T22:00:00'), UTC('2026-09-01T02:00:00')), [
      '2026-08-31',
      '2026-09-01',
    ]);
  });

  test('연 경계를 넘어간다', () => {
    assert.deepEqual(utcDatesInRange(UTC('2026-12-31T22:00:00'), UTC('2027-01-01T02:00:00')), [
      '2026-12-31',
      '2027-01-01',
    ]);
  });

  test('윤년 2월을 넘어간다', () => {
    assert.deepEqual(utcDatesInRange(UTC('2028-02-28T22:00:00'), UTC('2028-03-01T02:00:00')), [
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  test('to 가 from 보다 앞이면 빈 배열', () => {
    assert.deepEqual(utcDatesInRange(UTC('2026-08-29T00:00:00'), UTC('2026-08-28T00:00:00')), []);
  });

  test('NaN 을 넣어도 던지지 않는다', () => {
    assert.deepEqual(utcDatesInRange(NaN, Date.now()), []);
  });

  test('자정 정각이 경계에 걸려도 그 날을 포함한다', () => {
    assert.deepEqual(utcDatesInRange(UTC('2026-08-28T00:00:00'), UTC('2026-08-28T00:00:00')), ['2026-08-28']);
  });
});

describe('보존 기간', () => {
  const now = UTC('2026-08-28T12:00:00');

  test('오늘과 6일 전까지는 남아 있다', () => {
    assert.equal(isWithinRetention('2026-08-28', now), true);
    assert.equal(isWithinRetention('2026-08-22', now), true);
  });

  test('7일 전은 이미 지났다', () => {
    assert.equal(isWithinRetention('2026-08-21', now), false);
  });

  test('미래 날짜는 없는 것으로 본다', () => {
    assert.equal(isWithinRetention('2026-08-29', now), false);
  });

  test('보존 밖 날짜를 갈라낸다 — 요청도 하지 않는다', () => {
    const { retained, expired } = splitRetained(['2026-08-20', '2026-08-21', '2026-08-22', '2026-08-28'], now);
    assert.deepEqual(retained, ['2026-08-22', '2026-08-28']);
    assert.deepEqual(expired, ['2026-08-20', '2026-08-21']);
  });
});

describe('utcDate', () => {
  test('UTC 기준으로 자른다', () => {
    assert.equal(utcDate(KST('2026-08-29T08:59:59')), '2026-08-28');
    assert.equal(utcDate(KST('2026-08-29T09:00:00')), '2026-08-29');
  });
});
