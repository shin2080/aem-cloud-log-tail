import type { LogLevel } from '../../shared/types.js';
import { registerParser } from './parser.js';
import { LineBufferedParser, type ParsedLine } from './lineparser.js';

/**
 * httpderror — Apache 에러 로그. 실환경 표본:
 *
 *   Sat Aug 29 01:01:48.407729 2026 [managed_rewrite_maps:debug] [pid 118] [pod] Managed rewrite maps check DONE
 *
 * 오프셋 표기가 없다. AEMaaCS 컨테이너는 UTC 로 도므로 UTC 로 읽는다.
 */
const LINE =
  /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2})\.(\d+) (\d{4}) \[([^\]]*)\](?: \[pid (\d+)\])?(?: \[([^\]]+)\])? (.*)$/;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const LEVELS: Record<string, LogLevel> = {
  emerg: 'ERROR',
  alert: 'ERROR',
  crit: 'ERROR',
  error: 'ERROR',
  warn: 'WARN',
  notice: 'INFO',
  info: 'INFO',
  debug: 'DEBUG',
  trace1: 'TRACE',
  trace2: 'TRACE',
};

export class HttpdErrorParser extends LineBufferedParser {
  readonly name = 'httpderror';

  protected parseLine(line: string): ParsedLine | null {
    const m = LINE.exec(line);
    if (!m) return null;

    const [, mon, dd, hh, mi, ss, frac, yyyy, tag, pid, pod, message] = m;
    const month = MONTHS[mon!];
    if (month === undefined) return null;

    // 마이크로초까지 오므로 앞 3자리만 밀리초로 쓴다.
    const ms = Number(String(frac).slice(0, 3).padEnd(3, '0'));
    const ts = Date.UTC(+yyyy!, month, +dd!, +hh!, +mi!, +ss!, ms);

    // tag 는 'managed_rewrite_maps:debug' 또는 'core:error' 형태다.
    const [moduleName, levelWord] = (tag ?? '').split(':');

    return {
      ts,
      level: LEVELS[(levelWord ?? '').toLowerCase()] ?? 'UNKNOWN',
      pod: pod ?? '',
      thread: pid ? `pid ${pid}` : '',
      logger: moduleName ?? '',
      message: message ?? '',
      raw: line,
    };
  }
}

registerParser('httpderror', (startSeq) => new HttpdErrorParser(startSeq));
