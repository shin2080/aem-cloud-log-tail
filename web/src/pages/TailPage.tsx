import { useCallback, useMemo, useState } from 'react';
import { Alert, Box, Button, Group, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { FontSizeControl, useFontSize } from '../components/FontSizeControl';
import type { TimeZoneMode } from '../components/LogLine';
import { TailPane, paneKey, parsePane, type PaneTarget } from '../components/TailPane';
import { PanePicker } from '../components/PanePicker';
import { useSplitDirection } from '../components/useSplitDirection';
import { useT } from '../i18n';

/**
 * 브라우저는 같은 호스트로 가는 HTTP/1.1 연결을 6개쯤으로 제한한다.
 * 창 하나가 SSE 연결 하나를 계속 물고 있으므로, 너무 많이 열면
 * 나머지 API 호출(환경 조회·내보내기)이 굶는다.
 */
const MAX_PANES = 4;

export function TailPage() {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  const [timeZone, setTimeZone] = useState<TimeZoneMode>('KST');
  const [fontSize, setFontSize] = useFontSize();
  const [pickerOpen, setPickerOpen] = useState(false);
  // 고른 적 없으면 화면 폭으로 정한다. 와이드 모니터면 좌우, 좁으면 상하.
  const [direction, setDirection, isAuto] = useSplitDirection();

  /**
   * URL 이 곧 화면 상태다. 새로고침하거나 링크를 넘겨도 같은 조합이 열린다.
   * 예전 단일 형식(`?org=&env=&service=&name=`)도 계속 받는다.
   */
  const panes = useMemo<PaneTarget[]>(() => {
    const fromP = search.getAll('p').map(parsePane).filter((t): t is PaneTarget => t !== null);
    if (fromP.length > 0) return fromP.slice(0, MAX_PANES);

    const org = search.get('org');
    const env = search.get('env');
    const service = search.get('service');
    const name = search.get('name') ?? 'aemerror';
    return org && env && service ? [{ org, env, service, name }] : [];
  }, [search]);

  const setPanes = useCallback(
    (next: PaneTarget[]) => {
      const p = new URLSearchParams();
      for (const t of next.slice(0, MAX_PANES)) p.append('p', paneKey(t));
      setSearch(p, { replace: true });
    },
    [setSearch],
  );

  const addPane = (t: PaneTarget) => {
    // 같은 대상을 두 번 열면 서버 세션을 공유해 화면만 중복된다. 막는다.
    if (panes.some((x) => paneKey(x) === paneKey(t))) return;
    setPanes([...panes, t]);
  };

  const closePane = (i: number) => setPanes(panes.filter((_, idx) => idx !== i));

  // 첫 창이 '지금 보고 있는 환경' 이다. 창 추가는 이 환경 안에서만 고른다.
  const current = panes[0];
  if (!current) {
    return (
      <Alert color="red" variant="light" m="md">
        <Text size="sm">{t('panes.noTarget')}</Text>
      </Alert>
    );
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Group px="xs" py={4} gap="xs" wrap="nowrap" style={{ borderBottom: '1px solid var(--mantine-color-dark-4)', flexShrink: 0 }}>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {t('panes.count', { n: panes.length, max: MAX_PANES })}
        </Text>

        <Tooltip
          label={
            panes.length >= MAX_PANES ? t('panes.maxTail', { max: MAX_PANES }) : t('panes.addTipTail')
          }
          withArrow
        >
          <Button size="compact-xs" variant="default" disabled={panes.length >= MAX_PANES} onClick={() => setPickerOpen(true)}>
            {t('panes.add')}
          </Button>
        </Tooltip>

        {panes.length > 1 && (
          <Tooltip
            label={
              isAuto
                ? t('split.autoTail')
                : t('split.manualTail')
            }
            withArrow
          >
            <SegmentedControl
              size="xs"
              value={direction}
              onChange={(v) => setDirection(v as 'row' | 'column')}
              data={[
                { label: t('split.row') + (isAuto && direction === 'row' ? ' ·' : ''), value: 'row' },
                {
                  label: t('split.column') + (isAuto && direction === 'column' ? ' ·' : ''),
                  value: 'column',
                },
              ]}
            />
          </Tooltip>
        )}

        <Box style={{ flex: 1 }} />

        <SegmentedControl size="xs" value={timeZone} onChange={(v) => setTimeZone(v as TimeZoneMode)} data={['KST', 'UTC']} />
        <FontSizeControl value={fontSize} onChange={setFontSize} />
      </Group>

      <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: direction, gap: 2 }}>
        {panes.map((t, i) => (
          <TailPane
            key={paneKey(t)}
            target={t}
            timeZone={timeZone}
            fontSize={fontSize}
            closable={panes.length > 1}
            onClose={() => closePane(i)}
          />
        ))}
      </Box>

      <PanePicker
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={addPane}
        current={current}
        openKeys={panes.map(paneKey)}
      />
    </Box>
  );
}
