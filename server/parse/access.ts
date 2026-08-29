import { registerParser } from './parser.js';
import { LineBufferedParser, levelFromStatus, parseClfTime, type ParsedLine } from './lineparser.js';

/**
 * aemaccess / httpdaccess — 같은 포맷이다. 실환경 표본:
 *
 *   cm-p12345-e987654-aem-author-5fdcf57b86-j64vr 127.0.0.1 - 29/Aug/2026:00:58:48 +0000 "HEAD /libs/... HTTP/1.1" 200 13425
 *   cm-...-x8m4q ::1 - 29/Aug/2026:00:58:57 +0000 "POST /dispatcher/invalidate.cache HTTP/1.1" 200 13 "-" "python-requests/2.31.0"
 *
 * 뒤쪽 referer/UA 는 있을 때도 없을 때도 있다. 바이트 수가 '-' 인 경우도 있다.
 */
const LINE =
  /^(\S+) (\S+) (\S+) (\d{2}\/\w{3}\/\d{4}:\d{2}:\d{2}:\d{2}(?: [+-]\d{4})?) "([^"]*)" (\d{3}) (\S+)(?: "([^"]*)" "([^"]*)")?\s*$/;

export class AccessLogParser extends LineBufferedParser {
  /** 한 줄이 곧 한 엔트리다. 못 읽은 줄을 앞 엔트리에 붙이면 안 된다. */
  protected override readonly multiline = false;

  constructor(
    readonly name: string,
    startSeq = 0,
  ) {
    super(startSeq);
  }

  protected parseLine(line: string): ParsedLine | null {
    const m = LINE.exec(line);
    if (!m) return null;

    const [, pod, clientIp, user, time, request, statusRaw, bytes, referer, ua] = m;
    const ts = parseClfTime(time!);
    if (ts === null) return null;

    const status = Number(statusRaw);
    // "HEAD /libs/granite/... HTTP/1.1" → method, path
    const reqParts = (request ?? '').split(' ');
    const method = reqParts[0] ?? '';
    const path = reqParts[1] ?? '';

    const extras: string[] = [];
    if (bytes && bytes !== '-') extras.push(`${bytes}B`);
    if (user && user !== '-') extras.push(`user=${user}`);
    if (referer && referer !== '-') extras.push(`ref=${referer}`);
    if (ua && ua !== '-') extras.push(`ua=${ua}`);

    return {
      ts,
      // access 로그에는 레벨이 없다. 상태코드로 옮겨야 'ERROR 만 보기' 가 5xx 만 보기가 된다.
      level: levelFromStatus(status),
      pod: pod!,
      thread: clientIp === '-' ? '' : clientIp!,
      // 로거 자리에 'METHOD 상태' 를 넣어 뷰어의 로거 열이 의미를 갖게 한다.
      logger: `${method} ${status}`,
      message: `${path}${extras.length > 0 ? `  ${extras.join(' ')}` : ''}`,
      raw: line,
    };
  }
}

registerParser('aemaccess', (startSeq) => new AccessLogParser('aemaccess', startSeq));
registerParser('httpdaccess', (startSeq) => new AccessLogParser('httpdaccess', startSeq));
