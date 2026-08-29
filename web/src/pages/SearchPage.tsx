import { useCallback, useMemo, useState } from 'react';
import { Alert, Box, Button, Group, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useSearchParams } from 'react-router-dom';
import { FontSizeControl, useFontSize } from '../components/FontSizeControl';
import type { TimeZoneMode } from '../components/LogLine';
import { paneKey, parsePane, type PaneTarget } from '../components/TailPane';
import { SearchPane } from '../components/SearchPane';
import { PanePicker } from '../components/PanePicker';
import { useSplitDirection } from '../components/useSplitDirection';
import { useT, type TFunction } from '../i18n';

/** 창마다 조회 잡이 하나씩 돈다. 동시에 너무 많이 돌리면 Cloud Manager 를 두들긴다. */
const MAX_PANES = 4;

/** 분 단위로 둔다. 짧은 구간이 실제로 더 자주 쓰인다 — 방금 무슨 일이 났는지 볼 때. */
const PRESETS: number[] = [5, 10, 30, 60, 360, 1440];

/** 60분을 '1시간' 으로 읽어준다. 영어도 같은 규칙을 쓴다. */
function rangeLabel(minutes: number, t: TFunction): string {
  return minutes % 60 === 0
    ? t('range.hours', { n: minutes / 60 })
    : t('range.minutes', { n: minutes });
}

/**
 * 로그가 스토리지에 반영되기까지 실측 2분쯤 걸린다 (docs/findings.md).
 * 짧은 구간을 고르면 그 대부분이 아직 안 도착한 시간이라 결과가 비어 보인다.
 */
const PIPELINE_LAG_MIN = 2;

export function SearchPage() {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  const [from, setFrom] = useState<Date | null>(() => new Date(Date.now() - 3600_000));
  const [to, setTo] = useState<Date | null>(() => new Date());
  const [rangeMinutes, setRangeMinutes] = useState<number | null>(60);
  const [timeZone, setTimeZone] = useState<TimeZoneMode>('KST');
  const [fontSize, setFontSize] = useFontSize();
  const [direction, setDirection, isAuto] = useSplitDirection();
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 올라갈 때마다 모든 창이 함께 조회한다. */
  const [runToken, setRunToken] = useState(0);

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

  const addPane = (t: PaneTarget): void => {
    if (panes.some((x) => paneKey(x) === paneKey(t))) return;
    setPanes([...panes, t]);
  };

  const applyPreset = (minutes: number): void => {
    const now = new Date();
    setTo(now);
    setFrom(new Date(now.getTime() - minutes * 60_000));
    setRangeMinutes(minutes);
  };

  const canRun = Boolean(from && to && to > from && panes.length > 0);

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
      {/* 구간은 모든 창이 공유한다 — 비교의 요점이 '같은 시간대의 다른 로그' 다. */}
      <Box px="xs" py={6} style={{ borderBottom: '1px solid var(--mantine-color-dark-4)', flexShrink: 0 }}>
        <Group gap="xs" wrap="wrap">
          <DateTimePicker
            size="xs"
            value={from}
            onChange={(v) => {
              setFrom(v ? new Date(v) : null);
              setRangeMinutes(null);
            }}
            placeholder={t('common.from')}
            w={185}
          />
          <Text size="xs" c="dimmed">
            ~
          </Text>
          <DateTimePicker
            size="xs"
            value={to}
            onChange={(v) => {
              setTo(v ? new Date(v) : null);
              setRangeMinutes(null);
            }}
            placeholder={t('common.to')}
            w={185}
          />

          <Button.Group>
            {PRESETS.map((p) => (
              <Button
                key={p}
                size="compact-xs"
                variant={rangeMinutes === p ? 'filled' : 'default'}
                color="gray"
                onClick={() => applyPreset(p)}
              >
                {rangeLabel(p, t)}
              </Button>
            ))}
          </Button.Group>

          <Button size="compact-xs" disabled={!canRun} onClick={() => setRunToken((n) => n + 1)}>
            {panes.length > 1 ? t('search.runPanes', { n: panes.length }) : t('common.run')}
          </Button>

          <Box style={{ flex: 1 }} />

          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {t('panes.count', { n: panes.length, max: MAX_PANES })}
          </Text>
          <Tooltip
            label={
              panes.length >= MAX_PANES
                ? t('panes.maxSearch', { max: MAX_PANES })
                : t('panes.addTipSearch')
            }
            withArrow
          >
            <Button
              size="compact-xs"
              variant="default"
              disabled={panes.length >= MAX_PANES}
              onClick={() => setPickerOpen(true)}
            >
              {t('panes.add')}
            </Button>
          </Tooltip>

          {panes.length > 1 && (
            <Tooltip label={isAuto ? t('split.auto') : t('split.manual')} withArrow>
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

          <SegmentedControl
            size="xs"
            value={timeZone}
            onChange={(v) => setTimeZone(v as TimeZoneMode)}
            data={['KST', 'UTC']}
          />
          <FontSizeControl value={fontSize} onChange={setFontSize} />
        </Group>

        {from && to && to <= from && (
          <Text size="xs" c="red" mt={4}>
            {t('range.invalid')}
          </Text>
        )}

        {rangeMinutes !== null && rangeMinutes <= 10 && (
          <Text size="xs" c="dimmed" mt={4}>
            {t('range.lagHint', {
              lag: PIPELINE_LAG_MIN,
              range: rangeMinutes,
              tail: Math.min(PIPELINE_LAG_MIN, rangeMinutes),
            })}
          </Text>
        )}
      </Box>

      <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: direction, gap: 2 }}>
        {panes.map((t, i) => (
          <SearchPane
            key={paneKey(t)}
            target={t}
            from={from}
            to={to}
            runToken={runToken}
            timeZone={timeZone}
            fontSize={fontSize}
            closable={panes.length > 1}
            onClose={() => setPanes(panes.filter((_, idx) => idx !== i))}
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
