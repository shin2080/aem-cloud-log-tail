import type { LogLevel } from '../../shared/types.js';
import { registerParser } from './parser.js';
import { LineBufferedParser, type ParsedLine } from './lineparser.js';

/**
 * aemerror 라인 포맷:
 *   25.09.2023 15:34:56.428 [cm-p33452-e121351-aem-author-54c7ddc56c-vf8vb] *INFO* [sling-oak-observation-5] com.adobe.cq.Foo 메시지
 *
 * 타임스탬프는 UTC 다. 내부는 전부 epoch ms 로 다루고 표시할 때만 KST 로 바꾼다.
 * 실환경 표본 177줄에 100% 일치하는 것을 확인했다 (docs/findings.md).
 */
const LINE =
  /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) \[([^\]]+)\] \*(\w+)\* \[([^\]]*)\] (.*)$/;

const LEVELS: Record<string, LogLevel> = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  WARNING: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
  TRACE: 'TRACE',
};

function toLevel(raw: string): LogLevel {
  return LEVELS[raw.toUpperCase()] ?? 'UNKNOWN';
}

/** 'com.adobe.cq.Foo 메시지 본문' → ['com.adobe.cq.Foo', '메시지 본문'] */
function splitLogger(rest: string): [string, string] {
  const i = rest.indexOf(' ');
  if (i < 0) return [rest, ''];
  return [rest.slice(0, i), rest.slice(i + 1)];
}

export class AemErrorParser extends LineBufferedParser {
  readonly name = 'aemerror';

  protected parseLine(line: string): ParsedLine | null {
    const m = LINE.exec(line);
    if (!m) return null; // 스택트레이스 등 -- 기반 클래스가 continuation 으로 붙인다

    const [, dd, MM, yyyy, hh, mm, ss, ms, pod, level, thread, rest] = m;
    const [logger, message] = splitLogger(rest!);

    return {
      ts: Date.UTC(+yyyy!, +MM! - 1, +dd!, +hh!, +mm!, +ss!, +ms!),
      level: toLevel(level!),
      pod: pod!,
      thread: thread!,
      logger,
      message,
      raw: line,
    };
  }
}

registerParser('aemerror', (startSeq) => new AemErrorParser(startSeq));
