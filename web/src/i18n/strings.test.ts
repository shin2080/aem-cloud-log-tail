import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ko, en } from './strings.js';
import { format } from './format.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** web/src 아래의 모든 소스. i18n 폴더는 카탈로그 자신이라 뺀다. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'i18n') sources(full, out);
    } else if (/\.tsx?$/.test(name)) {
      out.push(readFileSync(full, 'utf8'));
    }
  }
  return out;
}

describe('화면 문자열 i18n', () => {
  test('두 카탈로그의 키가 같다', () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  });

  test('빈 문자열이 없다', () => {
    for (const [k, v] of Object.entries(ko)) assert.ok(v.trim().length > 0, k);
    for (const [k, v] of Object.entries(en)) assert.ok(v.trim().length > 0, k);
  });

  /**
   * 자리표시자가 어긋나면 한쪽 언어에서만 숫자가 사라진다.
   * 화면을 열어보기 전에는 눈에 안 띄는 종류의 실수라 여기서 잡는다.
   */
  test('두 언어의 자리표시자가 같다', () => {
    // 영어는 `단수|복수` 로 갈리므로 같은 이름이 두 번 나온다. 종류만 본다.
    const holders = (s: string) =>
      [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
    for (const k of Object.keys(ko) as (keyof typeof ko)[]) {
      assert.deepEqual(holders(en[k]), holders(ko[k]), `${k} 의 자리표시자가 어긋난다`);
    }
  });

  test('한국어에는 단수·복수 구분을 쓰지 않는다', () => {
    for (const [k, v] of Object.entries(ko)) {
      assert.ok(!v.includes('|'), `${k} 에 | 가 있다 — 한국어는 수를 구분하지 않는다`);
    }
  });

  test('영어의 단수·복수는 n 으로 갈린다', () => {
    assert.equal(format(en['viewer.selectedLines'], { n: 1 }), '1 line selected');
    assert.equal(format(en['viewer.selectedLines'], { n: 2 }), '2 lines selected');
    assert.equal(format(en['users.sessions'], { n: 1 }), '1 session');
    assert.equal(format(en['users.sessions'], { n: 3 }), '3 sessions');
  });

  test('숫자는 천 단위로 끊어 보여준다', () => {
    assert.equal(format(ko['pane.dropped'], { n: 12345 }), '버퍼가 넘쳐 12,345줄이 밀려났다');
  });

  test('값이 빠지면 자리표시자를 그대로 남긴다', () => {
    assert.equal(format('{a} 와 {b}', { a: '하나' }), '하나 와 {b}');
  });

  /**
   * 안 쓰는 문자열은 번역만 늘리고 화면에는 없다. 옮길 때 헷갈리는 원인이라
   * 남으면 알려준다. 키는 t('...') 로도, 표의 값으로도 쓰이므로 따옴표째 찾는다.
   */
  test('안 쓰는 키가 없다', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const blob = sources(srcDir).join('\n');
    const unused = (Object.keys(ko) as string[]).filter((k) => !blob.includes(`'${k}'`));
    assert.deepEqual(unused, [], `안 쓰는 키: ${unused.join(', ')}`);
  });
});
