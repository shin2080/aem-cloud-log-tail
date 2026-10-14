import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UpdateChecker, compareVersions, isNewer } from './check.js';

const release = (tag: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: `https://x/${tag}`, published_at: '2026-10-14T00:00:00Z', ...extra }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('버전 비교', () => {
  test('숫자로 비교한다 — 문자열 비교면 1.10 이 1.9 보다 작다', () => {
    assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
    assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
    assert.equal(compareVersions('2.0', '2.0.0'), 0);
  });

  test('프리릴리스 꼬리는 무시한다', () => {
    assert.equal(compareVersions('1.2.0-beta.1', '1.2.0'), 0);
  });

  test('isNewer', () => {
    assert.equal(isNewer('1.0.1', '1.0.0'), true);
    assert.equal(isNewer('1.0.0', '1.0.0'), false);
    assert.equal(isNewer('0.9.9', '1.0.0'), false);
  });
});

describe('업데이트 확인기', () => {
  test('새 릴리스가 있으면 알려준다', async () => {
    const c = new UpdateChecker({ repo: 'a/b', current: '1.0.0', fetchImpl: async () => release('v1.1.0') });
    const st = await c.checkOnce();
    assert.equal(st.error, null);
    assert.equal(c.available()?.tag, 'v1.1.0');
    assert.ok(st.checkedAt);
  });

  test('같거나 낮으면 없는 것이다', async () => {
    const c = new UpdateChecker({ repo: 'a/b', current: '1.1.0', fetchImpl: async () => release('v1.1.0') });
    await c.checkOnce();
    assert.equal(c.available(), null);
  });

  test('프리릴리스·초안은 세지 않는다', async () => {
    const c = new UpdateChecker({ repo: 'a/b', current: '1.0.0', fetchImpl: async () => release('v2.0.0', { prerelease: true }) });
    const st = await c.checkOnce();
    assert.equal(st.error, 'no_release');
    assert.equal(c.available(), null);
  });

  test('404(비공개 저장소)는 조용히 넘어간다', async () => {
    const c = new UpdateChecker({ repo: 'a/b', current: '1.0.0', fetchImpl: async () => new Response('', { status: 404 }) });
    const st = await c.checkOnce();
    assert.equal(st.error, 'http_404');
    assert.equal(c.available(), null);
  });

  test('인터넷이 없으면 unreachable, 느리면 timeout', async () => {
    const down = new UpdateChecker({ repo: 'a/b', current: '1.0.0', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal((await down.checkOnce()).error, 'unreachable');

    const slow = new UpdateChecker({
      repo: 'a/b',
      current: '1.0.0',
      timeoutMs: 20,
      fetchImpl: (_u, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    assert.equal((await slow.checkOnce()).error, 'timeout');
  });

  test('User-Agent 를 붙인다 — GitHub 은 없으면 403 을 준다', async () => {
    let ua = '';
    const c = new UpdateChecker({
      repo: 'a/b',
      current: '1.0.0',
      fetchImpl: async (_u, init) => {
        ua = String((init?.headers as Record<string, string>)['User-Agent']);
        return release('v1.0.0');
      },
    });
    await c.checkOnce();
    assert.match(ua, /aem-cloud-log-viewer\/1\.0\.0/);
  });
});
