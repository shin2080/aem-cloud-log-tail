import type { LogLevel } from '../../shared/types.js';
import { registerParser } from './parser.js';
import { LineBufferedParser, levelFromStatus, parseClfTime, type ParsedLine } from './lineparser.js';

/**
 * aemdispatcher — 실환경 표본:
 *
 *   [29/Aug/2026:01:01:57 +0000] [I] [pod] "POST /dispatcher/invalidate.cache" 200 0ms [publishfarm/-] [actionpath]
 *
 * 두 번째 대괄호가 레벨 한 글자다.
 */
const LINE =
  /^\[(\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?)\] \[(\w)\] \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+)ms(.*)$/;

const LEVEL_LETTER: Record<string, LogLevel> = {
  E: 'ERROR',
  W: 'WARN',
  I: 'INFO',
  D: 'DEBUG',
  T: 'TRACE',
};

export class AemDispatcherParser extends LineBufferedParser {
  readonly name = 'aemdispatcher';
  protected override readonly multiline = false;

  protected parseLine(line: string): ParsedLine | null {
    const m = LINE.exec(line);
    if (!m) return null;

    const [, time, letter, pod, request, statusRaw, durationRaw, rest] = m;
    const ts = parseClfTime(time!);
    if (ts === null) return null;

    const status = Number(statusRaw);
    const declared = LEVEL_LETTER[letter!.toUpperCase()] ?? 'UNKNOWN';
    // 디스패처가 I 로 찍어도 상태가 4xx/5xx 면 올린다. 놓치면 곤란한 쪽이다.
    // 다만 200 이라고 DEBUG 를 INFO 로 '승격' 시키지는 않는다 — 올리는 건 WARN 이상일 때만.
    const byStatus = levelFromStatus(status);
    const escalate = byStatus === 'WARN' || byStatus === 'ERROR';
    const level = escalate && rank(byStatus) > rank(declared) ? byStatus : declared;

    const reqParts = (request ?? '').split(' ');
    const method = reqParts[0] ?? '';
    const path = reqParts.slice(1).join(' ');

    return {
      ts,
      level,
      pod: pod!,
      thread: '',
      logger: `${method} ${status}`,
      message: `${path}  ${durationRaw}ms${rest ? ` ${rest.trim()}` : ''}`,
      raw: line,
    };
  }
}

const RANK: Record<string, number> = { ERROR: 3, WARN: 2, INFO: 1, DEBUG: 0, TRACE: 0, UNKNOWN: 0 };
const rank = (l: LogLevel): number => RANK[l] ?? 0;

registerParser('aemdispatcher', (startSeq) => new AemDispatcherParser(startSeq));
