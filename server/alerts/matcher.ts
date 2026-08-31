import type { LogEntry, LogLevel } from '../../shared/types.js';

/**
 * 규칙 하나를 실행 가능한 형태로 컴파일한다.
 *
 * 여기서 가장 중요한 것은 성능이 아니라 **폭주하지 않는 것**이다.
 * 지금까지 정규식은 화면에서만 돌아서 사용자가 자기 탭을 멈추는 게 전부였다.
 * 서버로 옮기면 못된 패턴 하나가 폴링 루프를 막아 모든 세션이 함께 선다.
 * Node 의 RegExp 에는 타임아웃이 없으므로, 막을 수 있는 곳에서 미리 막는다.
 */

/** 정규식에 물리기 전에 줄을 이만큼으로 자른다. 긴 줄일수록 역추적이 비싸다. */
const MAX_SCAN_CHARS = 4000;

/** 패턴 자체의 길이 상한 */
export const MAX_PATTERN_CHARS = 200;

export interface RuleSpec {
  pattern: string;
  isRegex: boolean;
  /** null 이면 전체 레벨 */
  levels: LogLevel[] | null;
}

export interface CompiledRule {
  test(entry: LogEntry): boolean;
}

export class PatternError extends Error {
  constructor(
    readonly key: 'pattern_empty' | 'pattern_too_long' | 'pattern_invalid' | 'pattern_dangerous',
    message: string,
  ) {
    super(message);
    this.name = 'PatternError';
  }
}

/**
 * 파국적 역추적을 일으키는 모양인가.
 *
 * 완전한 판별은 불가능하다. 실제로 사고를 내는 두 모양만 막는다 —
 * 중첩 수량자 `(a+)+` 와 겹치는 교대 `(a|a)*`. 나머지는 줄 길이 상한이 받아낸다.
 * 막지 못한 것이 남더라도, 알림 규칙은 사람이 하나씩 등록하는 것이라
 * 무작위 공격면이 아니라는 점이 완충이 된다.
 */
function looksCatastrophic(src: string): boolean {
  // (...)+ 나 (...)* 안에 또 수량자가 있는 경우
  if (/\([^)]*[+*}][^)]*\)\s*[+*]/.test(src)) return true;
  // 같은 것을 두 번 쓴 교대: (a|a)* 꼴
  if (/\(([^|)]+)\|\1\)\s*[+*]/.test(src)) return true;
  return false;
}

/** 등록 시점에 부른다. 못 쓸 패턴이면 여기서 던진다. */
export function compileRule(spec: RuleSpec): CompiledRule {
  const pattern = spec.pattern.trim();
  if (pattern.length === 0) throw new PatternError('pattern_empty', '패턴이 비어 있다');
  if (pattern.length > MAX_PATTERN_CHARS) {
    throw new PatternError('pattern_too_long', `패턴은 ${MAX_PATTERN_CHARS}자를 넘을 수 없다`);
  }

  const levelSet = spec.levels && spec.levels.length > 0 ? new Set(spec.levels) : null;

  if (!spec.isRegex) {
    // 기본은 부분문자열이다. 빠르고, 폭주할 수가 없다.
    const needle = pattern.toLowerCase();
    return {
      test: (e) => levelOk(e, levelSet) && haystack(e).toLowerCase().includes(needle),
    };
  }

  if (looksCatastrophic(pattern)) {
    throw new PatternError('pattern_dangerous', '역추적이 폭주할 수 있는 패턴이다. 더 단순하게 쓴다');
  }

  let re: RegExp;
  try {
    // g 를 붙이지 않는다. lastIndex 가 남아 다음 줄의 판정이 달라진다.
    re = new RegExp(pattern, 'i');
  } catch {
    throw new PatternError('pattern_invalid', '정규식이 올바르지 않다');
  }

  return {
    test: (e) => levelOk(e, levelSet) && re.test(haystack(e)),
  };
}

function levelOk(e: LogEntry, levels: Set<LogLevel> | null): boolean {
  return levels === null || levels.has(e.level);
}

/**
 * 규칙이 훑는 텍스트.
 *
 * **마스킹이 끝난 뒤의 값이다.** 알림에 실릴 수 있는 것은 구조적으로
 * 가려진 텍스트뿐이라는 뜻이고, 그 대가로 마스킹된 값(203.0.*.*)은 못 잡는다.
 */
function haystack(e: LogEntry): string {
  const body = e.continuation.length > 0 ? `${e.raw}\n${e.continuation.join('\n')}` : e.raw;
  return body.length > MAX_SCAN_CHARS ? body.slice(0, MAX_SCAN_CHARS) : body;
}
