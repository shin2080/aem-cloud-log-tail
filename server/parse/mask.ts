/**
 * 마스킹. 파서 직후, 링버퍼에 들어가기 전에 적용한다.
 *
 * 렌더링 단계에서 가리는 방식은 금지다 — 그러면 내보내기 파일에 원문이 그대로 나간다.
 * 여기서 가려진 것은 메모리에도 남지 않는다.
 */

export interface MaskRule {
  name: string;
  apply(text: string): string;
  /**
   * 이 줄에 규칙이 걸릴 여지가 있는가. 없으면 정규식을 아예 안 돌린다.
   *
   * 실측(200,000줄)으로 전체 459ms 중 email 규칙 혼자 223ms 였다.
   * 로그 대부분에는 `@` 가 없으므로 indexOf 한 번으로 절반이 사라진다.
   * **반드시 정규식이 매칭될 수 있는 조건의 상위집합이어야 한다** —
   * 여기서 잘못 걸러내면 가려져야 할 것이 조용히 통과한다.
   */
  when?(text: string): boolean;
}

/* ── 오탐 방지 헬퍼 ──────────────────────────────────────
 *
 * 로그에는 epoch ms(13자리)가 지천이다. SPEC 의 주민번호·신용카드 패턴을 곧이곧대로 쓰면
 * 타임스탬프가 통째로 가려진다. 아래 두 검사가 그걸 막는다.
 */

/** epoch ms 로 그럴듯한 13자리인가 (2001~2096년) */
function looksLikeEpochMs(digits: string): boolean {
  if (digits.length !== 13) return false;
  const n = Number(digits);
  return n >= 1_000_000_000_000 && n <= 4_000_000_000_000;
}

/** 주민번호 앞 6자리가 YYMMDD 로 말이 되는가 */
function plausibleYyMmDd(six: string): boolean {
  const mm = Number(six.slice(2, 4));
  const dd = Number(six.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/**
 * 사설·루프백·링크로컬 대역인가.
 *
 * 이 주소들은 사람이 아니라 인프라다 — 127.0.0.1, ::1, 쿠버네티스 파드망(172.16/12),
 * 10/8, 192.168/16. 이걸 가리면 로그가 못 읽게 되고 얻는 것도 없다.
 */
function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // 링크로컬
  if (a === 0 || a >= 224) return true; // 예약·멀티캐스트
  return false;
}

/**
 * IPv6 를 정규식 하나로 처리하면 `::` 압축형에서 주소 중간부터 매칭돼
 * 앞 헥스텟을 놓친다 (fe80::1234:... 를 1234 로 읽어 링크로컬 판정을 못 한다).
 * 후보를 통째로 뽑은 뒤 따로 판단한다.
 */
const IPV6_CANDIDATE = /(?<![0-9a-fA-F:.])(?=[0-9a-fA-F]{0,4}:)[0-9a-fA-F:]{3,45}(?![0-9a-fA-F:.])/g;

/** `::` 를 풀어 첫 헥스텟을 얻는다. 자리 수가 안 맞으면 IPv6 가 아니다. */
function firstHextet(addr: string): number | null {
  const parts = addr.split('::');
  if (parts.length > 2) return null;

  const head = (parts[0] ?? '').split(':').filter((x) => x.length > 0);
  const tail = parts.length === 2 ? (parts[1] ?? '').split(':').filter((x) => x.length > 0) : [];
  const groups = head.length + tail.length;

  if (parts.length === 1 && groups !== 8) return null;
  if (parts.length === 2 && groups > 7) return null;
  if (groups < 1) return null;
  if ([...head, ...tail].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;

  // '::1' 처럼 앞이 비었으면 첫 헥스텟은 0 이다 (미지정·루프백 대역).
  const first = head[0];
  return first === undefined ? 0 : parseInt(first, 16);
}

function maskIpv6(t: string): string {
  return t.replace(IPV6_CANDIDATE, (m) => {
    if ((m.match(/:/g) ?? []).length < 2) return m;
    const head = firstHextet(m);
    if (head === null) return m;

    // 0::/8(미지정·루프백), fc00::/7(사설), fe80::/10(링크로컬) 은 인프라다.
    if (head === 0) return m;
    if ((head & 0xfe00) === 0xfc00) return m;
    if ((head & 0xffc0) === 0xfe80) return m;

    const hextets = m.split(':').filter((x) => x.length > 0);
    return `${hextets[0]}:${hextets[1] ?? ''}:*`;
  });
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/* ── 규칙 ────────────────────────────────────────────── */

export const DEFAULT_RULES: MaskRule[] = [
  {
    /**
     * 공인 IPv4. access·cdn 로그의 cli_ip 는 **실제 방문자 주소**다.
     * SPEC 1장이 말한 'prod 로그에 섞인 실사용자 데이터' 가 바로 이것이다.
     *
     * /16 까지만 남긴다 — 어느 대역에서 왔는지는 디버깅에 쓰이지만
     * 개인을 특정하는 건 뒤 두 옥텟이다.
     */
    name: 'ipv4',
    apply: (t) =>
      t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, A: string, B: string, C: string, D: string) => {
        const [a, b, c, d] = [+A, +B, +C, +D];
        if ([a, b, c, d].some((n) => n > 255)) return m; // IP 가 아니다 (버전 문자열 등)
        if (isPrivateIpv4(a, b)) return m;
        return `${a}.${b}.*.*`;
      }),
  },
  {
    /** 공인 IPv6. 앞 두 헥스텟만 남긴다. 루프백(::1)·사설(fc00::/7)·링크로컬(fe80::/10)은 둔다. */
    name: 'ipv6',
    apply: maskIpv6,
  },
  {
    name: 'bearer',
    when: (t) => t.includes('Bearer'),
    apply: (t) => t.replace(/Bearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer ***'),
  },
  {
    name: 'basic',
    when: (t) => t.includes('Basic'),
    apply: (t) => t.replace(/Basic\s+[A-Za-z0-9+/=]{16,}/g, 'Basic ***'),
  },
  {
    // 쿼리스트링·설정값의 민감 키. 키 이름은 남기고 값만 지운다.
    name: 'sensitive-param',
    apply: (t) =>
      t.replace(/\b(password|passwd|pwd|token|secret|apikey|api_key|access_token|refresh_token)(\s*[=:]\s*)([^&\s,;"'}\]]+)/gi, '$1$2***'),
  },
  {
    // 도메인은 남긴다 — 어느 조직에서 온 주소인지는 디버깅에 필요하다.
    name: 'email',
    when: (t) => t.includes('@'),
    apply: (t) =>
      t.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2'),
  },
  {
    /**
     * 주민등록번호.
     * SPEC 은 `\d{6}[-\s]?[1-4]\d{6}` 를 제시했지만, 구분자가 없으면 epoch ms 와 구별이 안 된다.
     * 예: 1787924224661 → 178792|4|224661 로 패턴에 걸린다.
     * 앞 6자리가 YYMMDD 로 성립하는지 확인해 오탐을 걷어낸다.
     */
    name: 'krrn',
    apply: (t) =>
      t.replace(/(?<![\d.,])(\d{6})([-\s]?)([1-4]\d{6})(?![\d.,])/g, (m, front: string, sep: string) => {
        if (!plausibleYyMmDd(front)) return m;
        if (sep === '' && looksLikeEpochMs(front + m.slice(6))) return m;
        return '******-*******';
      }),
  },
  {
    /**
     * 신용카드. Luhn 을 통과하는 13~19자리.
     * 13자리 무구분자는 epoch ms 와 겹치므로(Luhn 우연 통과율 10%) 그 구간을 제외한다.
     */
    name: 'credit-card',
    apply: (t) =>
      // `\b` 만 쓰면 소수의 소수부를 통째로 집는다.
      // 실물 로그에서 `"confidence":0.1234567890139730` 의 소수부가 Luhn 을 통과해 가려졌다.
      // 앞뒤로 숫자·소수점·쉼표가 붙어 있으면 카드번호가 아니다.
      // 마지막 반복이 후행 구분자를 삼키지 않도록 숫자로 끝나게 고정한다.
      t.replace(/(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d.,])/g, (m) => {
        const digits = m.replace(/[ -]/g, '');
        if (digits.length < 13 || digits.length > 19) return m;
        if (looksLikeEpochMs(digits)) return m;
        if (!luhnOk(digits)) return m;
        return `****-****-****-${digits.slice(-4)}`;
      }),
  },
];

/**
 * 엔트리 전체를 가린다.
 *
 * raw/message/continuation 만 가리면 안 된다 — access·cdn 파서는 클라이언트 IP 를
 * thread 에 넣는다. 문자열 필드를 빠짐없이 통과시켜야 한 군데로 새지 않는다.
 */
export function maskEntry<T extends {
  raw: string;
  message: string;
  continuation: string[];
  pod: string;
  thread: string;
  logger: string;
  masked?: boolean;
}>(e: T, masker: Masker): T {
  let changed = false;
  const one = (v: string): string => {
    const [out, did] = masker.mask(v);
    changed = changed || did;
    return out;
  };

  const raw = one(e.raw);
  const message = one(e.message);
  const pod = one(e.pod);
  const thread = one(e.thread);
  const logger = one(e.logger);
  const continuation = e.continuation.map(one);

  return changed ? { ...e, raw, message, pod, thread, logger, continuation, masked: true } : e;
}

export class Masker {
  constructor(
    private readonly enabled: boolean,
    private readonly rules: MaskRule[] = DEFAULT_RULES,
  ) {}

  /** 가려진 게 있으면 [바뀐 문자열, true] */
  mask(text: string): [string, boolean] {
    if (!this.enabled || text.length === 0) return [text, false];
    let out = text;
    for (const r of this.rules) {
      if (r.when && !r.when(out)) continue;
      out = r.apply(out);
    }
    return [out, out !== text];
  }
}
