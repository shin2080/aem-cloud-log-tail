import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { signedUrlExpiry, normalizeEnvType, CloudManagerClient } from './cloudmanager.js';
import { ImsTokenCache } from './ims.js';
import type { OrgConfig } from '../config/env.js';

describe('signedUrlExpiry', () => {
  test('Azure SAS 의 se= 를 읽는다', () => {
    const url = 'https://x.blob.core.windows.net/logs/a.log?sv=2021-08-06&se=2026-08-28T15%3A30%3A00Z&sig=abc';
    assert.equal(signedUrlExpiry(url), Date.parse('2026-08-28T15:30:00Z'));
  });

  test('AWS SigV4 의 X-Amz-Date + X-Amz-Expires 를 더한다', () => {
    const url = 'https://x.s3.amazonaws.com/a.log?X-Amz-Date=20260828T150000Z&X-Amz-Expires=3600&X-Amz-Signature=abc';
    assert.equal(signedUrlExpiry(url), Date.parse('2026-08-28T15:00:00Z') + 3600_000);
  });

  test('만료 파라미터가 없으면 undefined', () => {
    assert.equal(signedUrlExpiry('https://x.example.com/a.log'), undefined);
  });

  test('URL 이 아니면 던지지 않고 undefined', () => {
    assert.equal(signedUrlExpiry('not a url'), undefined);
  });
});

describe('normalizeEnvType', () => {
  test('production / prod 를 prod 로 모은다', () => {
    assert.equal(normalizeEnvType('prod'), 'prod');
    assert.equal(normalizeEnvType('production'), 'prod');
    assert.equal(normalizeEnvType('PROD'), 'prod');
  });

  test('stage / staging 을 stage 로 모은다', () => {
    assert.equal(normalizeEnvType('stage'), 'stage');
    assert.equal(normalizeEnvType('staging'), 'stage');
  });

  test('rde 를 보존한다', () => {
    assert.equal(normalizeEnvType('rde'), 'rde');
  });

  /**
   * 모르는 값은 dev 로 떨어뜨린다.
   * prod 로 떨어뜨리면 접근이 막히고, 그보다 나쁜 건 알 수 없는 값을 prod 로 오인해
   * allow_prod 검사를 우회당하는 쪽이다. 안전한 기본값은 최소 권한 쪽 — 즉 dev 다.
   */
  test('모르는 값과 빈 값은 dev', () => {
    assert.equal(normalizeEnvType('sandbox'), 'dev');
    assert.equal(normalizeEnvType(undefined), 'dev');
    assert.equal(normalizeEnvType(''), 'dev');
  });
});

describe('resolveSignedUrl — download 와 tail 링크의 형태가 다르다', () => {
  const org: OrgConfig = {
    key: 'acme',
    label: 'ACME',
    imsOrgId: 'AAA@AdobeOrg',
    clientId: 'cid',
    clientSecret: 'sec',
    scopes: 'openid',
  };

  /**
   * tail 링크는 이미 서명된 Azure Blob URL 로 온다.
   * 이걸 Cloud Manager 경로로 착각해 Authorization 헤더와 함께 보내면 404 가 난다 (Phase 0b 에서 겪었다).
   */
  test('이미 서명된 스토리지 URL 은 네트워크를 타지 않고 그대로 돌려준다', async () => {
    let called = false;
    const cm = new CloudManagerClient(new ImsTokenCache(() => 0, async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }));

    const tail =
      'https://sa0.blob.core.windows.net/log-1-2/logs/author_aemerror_2026-08-28.log' +
      '?sig=abc%3D&api-version=2019-02-02&se=2026-08-29T14%3A10%3A21Z&sv=2019-02-02&sp=r&sr=b';

    const res = await cm.resolveSignedUrl(org, tail);
    assert.equal(res.url, tail, 'URL 을 손대지 않아야 한다');
    assert.equal(res.expiresAt, Date.parse('2026-08-29T14:10:21Z'));
    assert.equal(called, false, 'IMS 토큰조차 받을 필요가 없다');
  });

  test('Cloud Manager 상대 경로는 302 Location 을 따라간다', async () => {
    const signed = 'https://sa0.blob.core.windows.net/x/y.log.gz?se=2026-08-29T00%3A00%3A00Z&sig=z';
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).includes('ims')) {
        return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      assert.ok(String(url).startsWith('https://cloudmanager.adobe.io/api/program/1/'));
      return new Response(null, { status: 302, headers: { location: signed } });
    };
    const cm = new CloudManagerClient(new ImsTokenCache(() => 0, fetchImpl), fetchImpl);

    const res = await cm.resolveSignedUrl(org, '/api/program/1/environment/2/logs/download?service=author');
    assert.equal(res.url, signed);
    assert.equal(res.expiresAt, Date.parse('2026-08-29T00:00:00Z'));
  });
});
