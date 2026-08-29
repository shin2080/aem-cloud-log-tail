import { useEffect, useState } from 'react';
import { Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { compareLogNames, type AvailableService, type EnvironmentSummary } from '@shared/types';
import { api } from '../api/client';
import { ENV_COLOR } from '../theme';
import { paneKey, type PaneTarget } from './TailPane';
import { useT } from '../i18n';

/**
 * 창을 하나 더 열 때 무엇을 볼지 고른다.
 *
 * **지금 보고 있는 환경 안에서만** 고른다 — author 옆에 publish, 그 옆에 dispatcher.
 * 창을 나눠 보는 이유가 '같은 환경의 다른 계층에서 한 요청이 어떻게 흘러갔나' 이므로,
 * 여기서 다른 환경까지 늘어놓으면 고를 것만 많아지고 정작 원하는 건 찾기 어렵다.
 * 다른 환경은 환경 선택 화면에서 새로 연다.
 */
export function PanePicker({
  opened,
  onClose,
  onPick,
  current,
  openKeys,
}: {
  opened: boolean;
  onClose: () => void;
  onPick: (t: PaneTarget) => void;
  /** 지금 보고 있는 대상. 여기서 org·env 를 가져온다 */
  current: PaneTarget;
  /** 이미 열려 있는 창들. 같은 것을 또 고르지 못하게 막는다 */
  openKeys: string[];
}) {
  const t = useT();
  const [env, setEnv] = useState<EnvironmentSummary | null>(null);
  const [services, setServices] = useState<AvailableService[]>([]);
  const [supported, setSupported] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setLoading(true);

    // 환경 이름·유형은 캐시에서 온다. 무엇을 고르는 중인지 창 위에 남겨둔다.
    void api
      .environments(current.org)
      .then((r) => setEnv(r.environments.find((e) => e.environmentId === current.env) ?? null))
      .catch(() => setEnv(null));

    void api
      .logOptions(current.org, current.env)
      .then((r) => {
        setServices(r.services);
        setSupported(r.supported);
      })
      .catch(() => {
        setServices([]);
        setSupported([]);
      })
      .finally(() => setLoading(false));
  }, [opened, current.org, current.env]);

  const canOpen = (name: string): boolean => supported.length === 0 || supported.includes(name);

  const rows = services
    .map((s) => ({ service: s.service, names: [...s.logNames].filter(canOpen).sort(compareLogNames) }))
    .filter((s) => s.names.length > 0);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      title={
        <Group gap="xs">
          <Text size="sm" fw={600}>
            {t('picker.title')}
          </Text>
          {env && (
            <>
              <Badge size="xs" variant="light" color={ENV_COLOR[env.environmentType] ?? 'gray'}>
                {env.environmentType}
              </Badge>
              <Text size="xs" c="dimmed" ff="monospace">
                {env.environmentName}
              </Text>
            </>
          )}
        </Group>
      }
    >
      <Stack gap="sm">
        {loading && <Loader size="xs" />}

        {rows.map((s) => (
          <Group key={s.service} gap={4} wrap="wrap" align="center">
            <Text size="xs" c="dimmed" ff="monospace" style={{ minWidth: 130 }}>
              {s.service}
            </Text>
            {s.names.map((name) => {
              const target: PaneTarget = { org: current.org, env: current.env, service: s.service, name };
              const already = openKeys.includes(paneKey(target));
              return (
                <Button
                  key={name}
                  size="compact-xs"
                  variant="light"
                  color="gray"
                  disabled={already}
                  title={already ? t('picker.already') : undefined}
                  onClick={() => {
                    onPick(target);
                    onClose();
                  }}
                >
                  {name}
                </Button>
              );
            })}
          </Group>
        ))}

        {!loading && rows.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('picker.noLogs')}
          </Text>
        )}

        <Text size="xs" c="dimmed">
          {t('picker.otherEnv')}
        </Text>
      </Stack>
    </Modal>
  );
}
