import type { OrgConfig } from '../config/env.js';
import { CloudManagerClient, type LogOption } from '../adobe/cloudmanager.js';

export interface RangeRead {
  /** 206 = 새 데이터, 416 = 없음, 그 외는 오류 */
  status: number;
  bytes: Uint8Array;
  /** Content-Range 의 전체 크기. 모르면 -1 */
  totalSize: number;
}

/**
 * TailSession 이 바깥 세상과 닿는 유일한 지점.
 * 테스트에서는 이걸 가짜로 갈아끼워 롤오버·오프셋 로직만 검증한다.
 */
export interface ResolvedTail {
  /** 실제로 열린 파일의 UTC 날짜. 요청한 날짜와 다를 수 있다 */
  date: string;
  url: string;
}

export interface TailTransport {
  /**
   * 원하는 UTC 날짜의 평문 tail URL 을 연다.
   *
   * **그 날짜가 없으면 목록에 있는 가장 최근 날짜로 대체하고, 어떤 날짜를 열었는지 돌려준다.**
   * UTC 자정(=KST 오전 9시) 직후에는 Adobe 가 새 날짜 파일을 아직 목록에 올리지 않는다.
   * "오늘 파일은 당연히 있다" 고 가정하면 그 시간대에 tail 이 아예 안 열린다.
   */
  resolveTail(preferredDateUtc: string): Promise<ResolvedTail>;
  sizeOf(url: string): Promise<number>;
  readFrom(url: string, offset: number): Promise<RangeRead>;
}

/**
 * 실제 Cloud Manager + Azure Blob 을 쓰는 구현.
 *
 * tail URL 은 `logs?days=N` 응답 안에 서명된 채로 들어 있다 (Phase 0b).
 * 그 엔드포인트 호출은 Cloud Manager 레이트 리밋을 소모하므로 URL 을 캐시하고,
 * Range 폴링은 스토리지로 직접 나간다. 이 구조를 지키는 게 중요하다.
 */
export class CloudManagerTailTransport implements TailTransport {
  private readonly urlCache = new Map<string, { url: string; expiresAt: number }>();

  constructor(
    private readonly cm: CloudManagerClient,
    private readonly org: OrgConfig,
    private readonly programId: string,
    private readonly environmentId: string,
    private readonly service: string,
    private readonly logName: string,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async resolveTail(preferredDateUtc: string): Promise<ResolvedTail> {
    const hit = this.urlCache.get(preferredDateUtc);
    // 만료 80% 지점에서 갱신한다. TTL 이 24시간이라 실제로는 거의 안 탄다.
    if (hit && this.now() < hit.expiresAt) return { date: preferredDateUtc, url: hit.url };

    const options = await this.cm.listLogOptions(this.org, this.programId, this.environmentId, 1);
    const mine = options.filter(
      (o: LogOption) => o.service === this.service && o.name === this.logName && o.date && o.tailHref,
    );
    if (mine.length === 0) {
      throw new Error(`${this.service}/${this.logName} 의 tail 링크가 하나도 없다`);
    }

    // 원하는 날짜가 있으면 그것을, 없으면 가장 최근 날짜를 연다.
    const exact = mine.find((o) => o.date === preferredDateUtc);
    const chosen = exact ?? mine.reduce((a, b) => ((a.date ?? '') > (b.date ?? '') ? a : b));
    const date = chosen.date!;

    const cached = this.urlCache.get(date);
    if (cached && this.now() < cached.expiresAt) return { date, url: cached.url };

    const signed = await this.cm.resolveSignedUrl(this.org, chosen.tailHref!);
    const issuedAt = this.now();
    const expiresAt = signed.expiresAt ? issuedAt + (signed.expiresAt - issuedAt) * 0.8 : issuedAt + 3600_000;
    // 실제로 연 날짜로 캐시한다. 없는 날짜 키에 캐시하면 다음에 새 파일을 못 집는다.
    this.urlCache.set(date, { url: signed.url, expiresAt });
    return { date, url: signed.url };
  }

  async sizeOf(url: string): Promise<number> {
    const res = await this.fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
    await res.body?.cancel();
    const cr = res.headers.get('content-range');
    if (cr) return Number(cr.split('/')[1]);
    return Number(res.headers.get('content-length') ?? -1);
  }

  async readFrom(url: string, offset: number): Promise<RangeRead> {
    const res = await this.fetchImpl(url, { headers: { Range: `bytes=${offset}-` } });

    if (res.status === 416) {
      await res.body?.cancel();
      return { status: 416, bytes: new Uint8Array(0), totalSize: -1 };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const cr = res.headers.get('content-range');
    return { status: res.status, bytes: buf, totalSize: cr ? Number(cr.split('/')[1]) : -1 };
  }
}
