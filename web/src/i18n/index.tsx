import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { en, ko, type StringKey } from './strings';
import { format, type Params } from './format';

export type Lang = 'ko' | 'en';

const CATALOGS: Record<Lang, Record<StringKey, string>> = { ko, en };
const STORAGE_KEY = 'aclv.lang';

export type TFunction = (key: StringKey, params?: Params) => string;

/**
 * 처음 열 때 쓸 언어.
 * 저장해 둔 것이 우선이고, 없으면 브라우저 설정을 본다. 한국어가 아니면 영어다.
 */
function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'ko' || saved === 'en') return saved;
  } catch {
    // 사생활 보호 모드 등. 브라우저 설정으로 넘어간다.
  }
  const nav = typeof navigator === 'undefined' ? '' : navigator.language;
  return nav.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

interface LangValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFunction;
}

const Ctx = createContext<LangValue | null>(null);

/**
 * 고른 언어는 서버에도 알려야 한다 — 오류 메시지가 서버에서 오기 때문이다.
 * api 클라이언트가 요청마다 이 값을 읽어 `X-Lang` 으로 싣는다.
 */
let current: Lang = 'ko';
export function currentLang(): Lang {
  return current;
}

/**
 * 훅을 쓸 수 없는 곳에서 부르는 번역기 — api 클라이언트, SSE 콜백 같은 곳.
 * 컴포넌트 안에서는 useT() 를 쓴다. 이건 다시 그리기를 유발하지 않는다.
 */
export function tStatic(key: StringKey, params?: Params): string {
  return format(CATALOGS[current][key], params);
}

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const l = initialLang();
    current = l;
    return l;
  });

  const setLang = useCallback((l: Lang) => {
    current = l;
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // 저장 못 해도 이번 세션에는 적용된다
    }
  }, []);

  // 스크린리더와 브라우저 번역기가 언어를 알아야 한다.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback<TFunction>((key, params) => format(CATALOGS[lang][key], params), [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('LangProvider 밖에서 useLang 을 썼다');
  return v;
}

/** 문자열만 필요할 때. `const t = useT()` */
export function useT(): TFunction {
  return useLang().t;
}

export type { StringKey };
export { format, type Params } from './format';
