import { registerParser } from './parser.js';
import { LineBufferedParser, levelFromStatus, type ParsedLine } from './lineparser.js';

/**
 * cdn — JSON 한 줄에 필드 하나씩. 실환경 표본:
 *
 *   {"timestamp":"2026-08-29T00:58:34+0000","ttfb":42,"ttlb":42,"cli_ip":"...","cli_country":"KR",...}
 *
 * 필드 구성이 환경마다 다를 수 있어 아는 필드만 골라 쓰고 나머지는 raw 로 남긴다.
 */
interface CdnRecord {
  timestamp?: string;
  ttfb?: number;
  ttlb?: number;
  cli_ip?: string;
  cli_country?: string;
  status?: number;
  url?: string;
  host?: string;
  method?: string;
  cache?: string;
  cache_status?: string;
  rid?: string;
  [k: string]: unknown;
}

/** '2026-08-29T00:58:34+0000' — 콜론 없는 오프셋이라 Date.parse 가 못 읽는다. */
function parseCdnTime(s: string): number | null {
  const normalized = s.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : t;
}

export class CdnParser extends LineBufferedParser {
  readonly name = 'cdn';
  protected override readonly multiline = false;

  protected parseLine(line: string): ParsedLine | null {
    if (!line.startsWith('{')) return null;

    let rec: CdnRecord;
    try {
      rec = JSON.parse(line) as CdnRecord;
    } catch {
      return null;
    }
    if (!rec.timestamp) return null;
    const ts = parseCdnTime(rec.timestamp);
    if (ts === null) return null;

    const status = typeof rec.status === 'number' ? rec.status : 0;
    const cache = rec.cache ?? rec.cache_status ?? '';
    const parts: string[] = [];
    if (rec.url) parts.push(String(rec.url));
    if (typeof rec.ttlb === 'number') parts.push(`${rec.ttlb}ms`);
    if (cache) parts.push(`cache=${cache}`);
    if (rec.cli_country) parts.push(String(rec.cli_country));

    return {
      ts,
      level: status > 0 ? levelFromStatus(status) : 'INFO',
      pod: rec.host ? String(rec.host) : '',
      thread: rec.cli_ip ? String(rec.cli_ip) : '',
      logger: `${rec.method ?? ''} ${status || ''}`.trim(),
      // 아는 필드가 없으면 원본을 그대로 보여준다. 감추는 것보다 낫다.
      message: parts.length > 0 ? parts.join('  ') : line,
      raw: line,
    };
  }
}

registerParser('cdn', (startSeq) => new CdnParser(startSeq));
