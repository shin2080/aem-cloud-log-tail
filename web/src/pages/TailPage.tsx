import { useCallback, useMemo, useState } from 'react';
import { Alert, Box, Button, Group, SegmentedControl, Text, Tooltip } from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import { FontSizeControl, useFontSize } from '../components/FontSizeControl';
import type { TimeZoneMode } from '../components/LogLine';
import type { LogLevel } from '@shared/types';
import {
  TailPane,
  DEFAULT_FILTER,
  paneKey,
  parsePane,
  type PaneFilter,
  type PaneTarget,
} from '../components/TailPane';
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
  // 한 창에서 Shift+클릭한 시각을 모든 창에 전한다. 일련번호는 같은 시각 재클릭용이다.
  const [sharedSeek, setSharedSeek] = useState<{ ts: number; n: number } | null>(null);
  const seekAll = useCallback((ts: number) => setSharedSeek((s) => ({ ts, n: (s?.n ?? 0) + 1 })), []);
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

  /**
   * 창마다의 필터. `p` 와 같은 순서로 `levels`·`q`·`re` 가 나란히 실린다.
   *
   * 없으면 기본(WARN+)이고, `levels=` 처럼 비어 있으면 '전체' 다 — 둘은 다르다.
   * 필터 없는 옛 링크는 그대로 기본으로 열린다.
   */
  const filters = useMemo<PaneFilter[]>(() => {
    const ls = search.getAll('levels');
    const qs = search.getAll('q');
    const res = search.getAll('re');
    return panes.map((_, i) => ({
      levels: ls[i] === undefined ? DEFAULT_FILTER.levels : (ls[i]!.split(',').filter(Boolean) as LogLevel[]),
      query: qs[i] ?? '',
      regex: res[i] === '1',
    }));
  }, [search, panes]);

  const write = useCallback(
    (nextPanes: PaneTarget[], nextFilters: PaneFilter[]) => {
      const kept = nextPanes.slice(0, MAX_PANES);
      const p = new URLSearchParams();
      for (const t of kept) p.append('p', paneKey(t));
      // 하나라도 기본값이 아니면 전부 싣는다. 일부만 실으면 자리가 어긋나
      // 어느 창의 필터인지 알 수 없다. 전부 기본이면 아무것도 안 실어 URL 을 짧게 둔다.
      if (kept.some((_, i) => !isDefaultFilter(nextFilters[i] ?? DEFAULT_FILTER))) {
        kept.forEach((_, i) => {
          const f = nextFilters[i] ?? DEFAULT_FILTER;
          p.append('levels', f.levels.join(','));
          p.append('q', f.query);
          p.append('re', f.regex ? '1' : '0');
        });
      }
      setSearch(p, { replace: true });
    },
    [setSearch],
  );

  const addPane = (t: PaneTarget) => {
    // 같은 대상을 두 번 열면 서버 세션을 공유해 화면만 중복된다. 막는다.
    if (panes.some((x) => paneKey(x) === paneKey(t))) return;
    write([...panes, t], [...filters, DEFAULT_FILTER]);
  };

  const closePane = (i: number) =>
    write(
      panes.filter((_, idx) => idx !== i),
      filters.filter((_, idx) => idx !== i),
    );

  const applyToAll = (f: PaneFilter) =>
    write(
      panes,
      panes.map(() => f),
    );

  const setPaneFilter = (i: number, f: PaneFilter) =>
    write(
      panes,
      filters.map((x, idx) => (idx === i ? f : x)),
    );

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
            filter={filters[i] ?? DEFAULT_FILTER}
            onFilterChange={(f) => setPaneFilter(i, f)}
            sharedSeek={sharedSeek}
            onSeekAll={panes.length > 1 ? seekAll : undefined}
            onApplyToAll={panes.length > 1 ? applyToAll : undefined}
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

function isDefaultFilter(f: PaneFilter): boolean {
  const same =
    f.levels.length === DEFAULT_FILTER.levels.length &&
    [...f.levels].sort().join() === [...DEFAULT_FILTER.levels].sort().join();
  return same && f.query === '' && !f.regex;
}
