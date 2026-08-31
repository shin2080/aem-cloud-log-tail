import { useCallback, useEffect, useState } from 'react';
import { Badge, Box, Button, Group, Indicator, Menu, Stack, Text, UnstyledButton } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { paneUrlFor, useAlertStream, type AlertHit } from '../api/alerts';
import { notifyState, showHitNotification, toggleDesktopNotify, type NotifyState } from '../lib/desktopNotify';
import { useT, type StringKey } from '../i18n';

const LEVEL_COLOR: Record<string, string> = { ERROR: 'red', WARN: 'yellow' };

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  return `${Math.floor(s / 3600)}시간`;
}

const NOTIFY_LABEL: Record<NotifyState, StringKey> = {
  on: 'alerts.desktopOn',
  off: 'alerts.desktopOff',
  blocked: 'alerts.desktopBlocked',
  unsupported: 'alerts.desktopUnsupported',
};

/**
 * 머리줄의 벨.
 *
 * 앱 안의 알림함(1단계)과 OS 토스트(2단계) 둘 다 여기서 나간다.
 * 토스트는 창이 다른 것에 가려 있을 때를 위한 것이다 — 모니터에 띄워둔 화면이
 * 뒤에 있으면 배지가 바뀌어도 아무도 못 본다.
 *
 * 닫혀 있을 때도 받으려면 웹푸시가 필요한데, 그건 새 노출면(제3자 푸시 서비스)을
 * 만드는 결정이라 따로 정해야 한다.
 */
export function AlertBell() {
  const t = useT();
  const navigate = useNavigate();
  const [opened, setOpened] = useState(false);
  const [hits, setHits] = useState<AlertHit[]>([]);
  const [now, setNow] = useState(Date.now());
  const { unread, latest, setUnread } = useAlertStream(true);
  const [notify, setNotify] = useState<NotifyState>('off');

  // 권한은 브라우저가 들고 있다. 다른 탭에서 바꿨을 수도 있으니 열 때마다 다시 본다.
  useEffect(() => {
    setNotify(notifyState());
  }, [opened]);

  const load = useCallback(async () => {
    try {
      const r = await api.alertHits(50);
      setHits(r.hits);
      setUnread(r.unread);
    } catch {
      // 알림함을 못 불러온 것으로 화면 전체가 흔들릴 이유는 없다.
    }
  }, [setUnread]);

  // 열 때 최신을 받아온다. 스트림으로 온 것은 목록 맨 앞에 끼워 넣는다.
  useEffect(() => {
    if (opened) void load();
  }, [opened, load]);

  useEffect(() => {
    if (!latest) return;
    setHits((cur) => (cur.some((h) => h.id === latest.id) ? cur : [latest, ...cur].slice(0, 50)));

    // OS 토스트. 규칙 이름과 어디서 몇 건인지까지만 싣는다 —
    // 알림은 잠금화면과 알림센터에 남으므로 로그 본문이 거기 갈 이유가 없다.
    void showHitNotification(
      latest,
      {
        title: latest.ruleName,
        body: t('alerts.notifyBody', { service: latest.service, logName: latest.logName, n: latest.count }),
      },
      paneUrlFor(latest),
    );
  }, [latest, t]);

  // '몇 분 전' 이 멈춰 있으면 알림이 언제 온 건지 알 수 없다.
  useEffect(() => {
    if (!opened) return;
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [opened]);

  const markAll = async (): Promise<void> => {
    try {
      const r = await api.markAlertsRead();
      setUnread(r.unread);
      setHits((cur) => cur.map((h) => ({ ...h, read: true })));
    } catch {
      // 다음에 다시 누르면 된다
    }
  };

  const open = (h: AlertHit): void => {
    setOpened(false);
    void api.markAlertsRead([h.id]).then((r) => setUnread(r.unread)).catch(() => {});
    navigate(paneUrlFor(h));
  };

  return (
    <Menu position="bottom-end" opened={opened} onChange={setOpened} width={380} withArrow>
      <Menu.Target>
        <Indicator disabled={unread === 0} label={unread > 99 ? '99+' : unread} size={16} color="red" offset={4}>
          <Button
            variant="subtle"
            size="compact-sm"
            color="gray"
            aria-label={unread > 0 ? t('alerts.bellAria', { n: unread }) : t('alerts.bellAriaEmpty')}
          >
            <span aria-hidden="true">🔔</span>
          </Button>
        </Indicator>
      </Menu.Target>

      <Menu.Dropdown>
        <Group justify="space-between" px="sm" pt={6} pb={4} wrap="nowrap">
          <Text size="sm" fw={600}>
            {t('alerts.title')}
          </Text>
          <Group gap={4}>
            {unread > 0 && (
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => void markAll()}>
                {t('alerts.markAllRead')}
              </Button>
            )}
            <Button size="compact-xs" variant="subtle" onClick={() => { setOpened(false); navigate('/alerts'); }}>
              {t('alerts.manage')}
            </Button>
          </Group>
        </Group>

        {/*
          데스크톱 알림 켜기. 권한 요청은 반드시 사람이 누른 자리에서 해야 한다 —
          로드하자마자 물어보면 브라우저가 무시하고 사람도 이유를 모른 채 거절한다.
        */}
        <Box px="sm" pb={6} style={{ borderBottom: '1px solid var(--mantine-color-dark-4)' }}>
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Box style={{ minWidth: 0 }}>
              <Text size="xs">{t('alerts.desktop')}</Text>
              <Text size="xs" c="dimmed">
                {notify === 'blocked' ? t('alerts.desktopBlockedHint') : t('alerts.desktopNote')}
              </Text>
            </Box>
            <Button
              size="compact-xs"
              variant={notify === 'on' ? 'filled' : 'default'}
              color={notify === 'blocked' ? 'yellow' : 'gray'}
              disabled={notify === 'unsupported' || notify === 'blocked'}
              onClick={() => void toggleDesktopNotify().then(setNotify)}
            >
              {t(NOTIFY_LABEL[notify])}
            </Button>
          </Group>
        </Box>

        <Box style={{ maxHeight: 380, overflowY: 'auto' }}>
          {hits.length === 0 ? (
            <Stack gap={2} align="center" py="lg" px="sm">
              <Text size="sm">{t('alerts.empty')}</Text>
              <Text size="xs" c="dimmed" ta="center">
                {t('alerts.emptyHint')}
              </Text>
            </Stack>
          ) : (
            hits.map((h) => (
              <UnstyledButton
                key={h.id}
                onClick={() => open(h)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 12px',
                  borderLeft: h.read ? '2px solid transparent' : '2px solid var(--mantine-color-blue-6)',
                }}
              >
                <Group gap={6} wrap="nowrap" align="flex-start">
                  <Badge size="xs" color={LEVEL_COLOR[h.level] ?? 'gray'} variant={h.level === 'ERROR' ? 'filled' : 'light'}>
                    {h.level}
                  </Badge>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" fw={h.read ? 400 : 600} truncate>
                      {h.ruleName}
                      {h.count > 1 && (
                        <Text span size="xs" c="dimmed">
                          {' '}
                          ×{h.count.toLocaleString()}
                        </Text>
                      )}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace" truncate>
                      {h.service} · {h.logName}
                    </Text>
                  </Box>
                  <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                    {ago(h.lastTs, now)}
                  </Text>
                </Group>
              </UnstyledButton>
            ))
          )}
        </Box>

        {/* 알림이 2분쯤 늦는다는 것을 말해두지 않으면 "안 온다" 는 오해가 반드시 생긴다 */}
        <Text size="xs" c="dimmed" px="sm" py={6} style={{ borderTop: '1px solid var(--mantine-color-dark-4)' }}>
          {t('alerts.lagNote')}
        </Text>
      </Menu.Dropdown>
    </Menu>
  );
}
