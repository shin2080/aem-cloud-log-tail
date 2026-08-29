import type { LogLevel } from '../../shared/types.js';
import { registerParser } from './parser.js';
import { LineBufferedParser, levelFromStatus, parseClfTime, type ParsedLine } from './lineparser.js';

/**
 * aemrequest — 요청 하나가 두 줄로 온다. 실환경 표본:
 *
 *   29/Aug/2026:01:01:53 +0000 [8072] -> HEAD /libs/granite/core/content/login.html HTTP/1.1 [pod]
 *   29/Aug/2026:01:01:53 +0000 [8072] <- 200 text/html;charset=utf-8 12ms [pod]
 *
 * `->` 가 요청, `<-` 가 응답이고 `[8072]` 로 짝지어진다.
 * 응답 줄에 상태코드와 소요시간이 있어 성능 디버깅에 쓸모 있는 쪽은 이쪽이다.
 */
const IN = /^(\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?) \[(\d+)\] -> (\S+) (\S+) (\S+) \[([^\]]+)\]\s*$/;
const OUT = /^(\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?) \[(\d+)\] <- (\d{3}) (.*?) (\d+)ms \[([^\]]+)\]\s*$/;

/** 느린 요청은 상태코드가 200 이어도 눈에 띄어야 한다. */
const SLOW_MS = 1000;
const VERY_SLOW_MS = 5000;

export class AemRequestParser extends LineBufferedParser {
  readonly name = 'aemrequest';
  protected override readonly multiline = false;

  /** requestId → 요청 줄의 정보. 응답 줄에서 합친다. */
  private readonly pending = new Map<string, { method: string; path: string }>();

  protected parseLine(line: string): ParsedLine | null {
    const out = OUT.exec(line);
    if (out) {
      const [, time, id, statusRaw, contentType, durationRaw, pod] = out;
      const ts = parseClfTime(time!);
      if (ts === null) return null;

      const status = Number(statusRaw);
      const duration = Number(durationRaw);
      const req = this.pending.get(id!);
      this.pending.delete(id!);

      // 요청 줄이 버퍼 앞쪽에서 잘려 안 보일 수 있다. 그때는 경로 없이 낸다.
      const what = req ? `${req.method} ${req.path}` : '(요청 줄 없음)';

      return {
        ts,
        level: worst(levelFromStatus(status), levelFromDuration(duration)),
        pod: pod!,
        thread: id!,
        logger: `${req?.method ?? '?'} ${status}`,
        message: `${duration}ms  ${what}${contentType ? `  ${contentType.trim()}` : ''}`,
        raw: line,
      };
    }

    const inc = IN.exec(line);
    if (inc) {
      const [, time, id, method, path, , pod] = inc;
      const ts = parseClfTime(time!);
      if (ts === null) return null;

      this.pending.set(id!, { method: method!, path: path! });
      // 짝 맞추기용 메모리가 무한정 자라지 않게 한다 (응답이 영영 안 오는 요청).
      if (this.pending.size > 5000) {
        for (const k of [...this.pending.keys()].slice(0, 1000)) this.pending.delete(k);
      }

      return {
        ts,
        level: 'INFO',
        pod: pod!,
        thread: id!,
        logger: `${method} →`,
        message: path!,
        raw: line,
      };
    }

    return null;
  }
}

function levelFromDuration(ms: number): LogLevel {
  if (ms >= VERY_SLOW_MS) return 'ERROR';
  if (ms >= SLOW_MS) return 'WARN';
  return 'INFO';
}

const RANK: Record<string, number> = { ERROR: 3, WARN: 2, INFO: 1, DEBUG: 0, TRACE: 0, UNKNOWN: 0 };

function worst(a: LogLevel, b: LogLevel): LogLevel {
  return (RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b;
}

registerParser('aemrequest', (startSeq) => new AemRequestParser(startSeq));
