import { useCallback, useEffect, useState } from 'react';
import { Menu, Button } from '@mantine/core';
import { FONT_LABEL, type FontSize } from './LogLine';
import { useT } from '../i18n';

const KEY = 'aclv.fontSize';
const SIZES: FontSize[] = ['xs', 'sm', 'md', 'lg'];

function read(): FontSize {
  try {
    const v = localStorage.getItem(KEY);
    return SIZES.includes(v as FontSize) ? (v as FontSize) : 'md';
  } catch {
    // 사생활 보호 모드 등에서 접근 자체가 막힐 수 있다.
    return 'md';
  }
}

/** 브라우저에 기억시킨다. 로그를 오래 보는 도구라 매번 다시 맞추게 하면 안 된다. */
export function useFontSize(): [FontSize, (v: FontSize) => void] {
  const [size, setSize] = useState<FontSize>('md');

  useEffect(() => {
    setSize(read());
  }, []);

  const update = useCallback((v: FontSize) => {
    setSize(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {
      // 저장 못 해도 이번 세션에는 적용된다
    }
  }, []);

  return [size, update];
}

export function FontSizeControl({ value, onChange }: { value: FontSize; onChange: (v: FontSize) => void }) {
  const t = useT();
  return (
    <Menu position="bottom-end" withArrow>
      <Menu.Target>
        <Button size="compact-xs" variant="default" aria-label={t('font.label')}>
          <span aria-hidden="true">가</span>
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('font.label')}</Menu.Label>
        {SIZES.map((s) => (
          <Menu.Item key={s} onClick={() => onChange(s)} fw={s === value ? 700 : 400}>
            {t(FONT_LABEL[s])}
            {s === value ? ' ·' : ''}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
