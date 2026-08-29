import { SegmentedControl } from '@mantine/core';
import { useLang } from '../i18n';

/**
 * 언어 전환. KST/UTC 토글과 같은 모양이라 하는 일이 바로 읽힌다.
 *
 * 로그인 화면에도 놓는다 — 로그인하기 전에 이미 화면이 한국어로 떠 있는데
 * 바꿀 방법이 머리줄 메뉴 안에만 있으면 들어가지도 못하고 못 바꾼다.
 */
export function LangToggle({ size = 'xs' }: { size?: 'xs' | 'sm' }) {
  const { lang, setLang } = useLang();
  return (
    <SegmentedControl
      size={size}
      value={lang}
      onChange={(v) => setLang(v === 'en' ? 'en' : 'ko')}
      data={[
        { label: '한국어', value: 'ko' },
        { label: 'English', value: 'en' },
      ]}
    />
  );
}
