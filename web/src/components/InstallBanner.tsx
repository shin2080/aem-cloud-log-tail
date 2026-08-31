import { useEffect, useState } from 'react';
import { ActionIcon, Box, Button, Group, Text } from '@mantine/core';
import {
  dismissInstallBanner,
  installState,
  onInstallStateChange,
  promptInstall,
  type InstallState,
} from '../pwa';
import { useT } from '../i18n';

/** 배너가 차지하는 높이. AppShell 의 머리줄 높이 계산이 이 값을 쓴다. */
export const INSTALL_BANNER_HEIGHT = 34;

/**
 * 설치형으로 열라고 한 번 권한다.
 *
 * 모니터에 걸어두는 쓰임에서는 설치형이 기본값이어야 하는데 — 창 장식이 사라지고
 * 알림이 앱처럼 뜬다 — 주소창의 설치 아이콘은 아무도 안 본다.
 *
 * 설치할 수 없는 상황에서는 아무 말도 하지 않는다. 평문 HTTP 나 설치 경로가 없는
 * 브라우저에서 "설치하세요" 를 띄우면, 시키는 대로 해도 안 되는 안내가 된다.
 */
export function useInstallBanner(): InstallState {
  const [state, setState] = useState<InstallState>('hidden');

  useEffect(() => {
    const sync = (): void => setState(installState());
    sync();
    return onInstallStateChange(sync);
  }, []);

  return state;
}

export function InstallBanner({ state }: { state: InstallState }) {
  const t = useT();
  if (state === 'hidden') return null;

  return (
    <Box
      px="sm"
      style={{
        height: INSTALL_BANNER_HEIGHT,
        display: 'flex',
        alignItems: 'center',
        background: 'var(--mantine-color-dark-6)',
        borderBottom: '1px solid var(--mantine-color-dark-4)',
      }}
    >
      <Group gap="xs" wrap="nowrap" style={{ width: '100%' }}>
        <Text size="xs" style={{ flex: 1, minWidth: 0 }} truncate>
          {state === 'prompt' ? t('install.pitch') : t('install.pitchIos')}
        </Text>

        {state === 'prompt' && (
          <Button size="compact-xs" onClick={() => void promptInstall()}>
            {t('install.action')}
          </Button>
        )}

        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          aria-label={t('install.dismiss')}
          onClick={dismissInstallBanner}
        >
          <span aria-hidden="true">✕</span>
        </ActionIcon>
      </Group>
    </Box>
  );
}
