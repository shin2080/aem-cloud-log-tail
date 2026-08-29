/**
 * 문자열에 값을 끼워 넣는다. React 를 끌어오지 않는 파일로 떼어 두었다 —
 * 카탈로그 검사는 브라우저 없이 도는 편이 낫다.
 */
export type Params = Record<string, string | number>;

export function format(template: string, params?: Params): string {
  let s = template;

  // `단수|복수`. n 이 1이면 앞, 아니면 뒤. 한국어 문자열에는 `|` 를 쓰지 않는다.
  if (s.includes('|')) {
    const [one, other] = s.split('|');
    s = Number(params?.n) === 1 ? (one as string) : (other as string);
  }

  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return typeof v === 'number' ? v.toLocaleString() : v;
  });
}

