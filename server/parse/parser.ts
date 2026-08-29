import type { LogEntry } from '../../shared/types.js';

/**
 * 스트리밍 로그 파서.
 *
 * 청크는 임의의 바이트 경계에서 잘려 들어온다. 구현체는 마지막 개행 이후의
 * 잔여를 내부에 들고 다음 청크 앞에 이어붙여야 한다.
 *
 * push() 는 '새로 만들어졌거나 내용이 바뀐' 엔트리를 돌려준다.
 * 스택트레이스가 뒤늦게 도착하면 직전 엔트리가 다시 나온다 — 호출자는 seq 로 upsert 한다.
 */
export interface LogParser {
  readonly name: string;
  push(chunk: string): LogEntry[];
  /** 스트림 끝. 잔여 바이트를 마지막 라인으로 처리한다. */
  flush(): LogEntry[];
  /** 다음에 부여할 seq. 롤오버 시 새 파서에 이어붙일 때 쓴다. */
  readonly nextSeq: number;
}

export type LogParserFactory = (startSeq: number) => LogParser;

const registry = new Map<string, LogParserFactory>();

export function registerParser(logName: string, factory: LogParserFactory): void {
  registry.set(logName, factory);
}

export function hasParser(logName: string): boolean {
  return registry.has(logName);
}

/** 프론트가 '열 수 있는 로그' 를 구분해 그리려면 이 목록이 필요하다. */
export function supportedLogNames(): string[] {
  return [...registry.keys()].sort();
}

export function createParser(logName: string, startSeq = 0): LogParser {
  const f = registry.get(logName);
  if (!f) throw new Error(`'${logName}' 로그의 파서가 없다. 등록된 것: ${[...registry.keys()].join(', ') || '(없음)'}`);
  return f(startSeq);
}
