import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Menu,
  Progress,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import type { EnvironmentSummary, LogLevel } from '@shared/types';
import { api } from '../api/client';
import { useSearch } from '../api/search';
import { LogViewer } from './LogViewer';
import type { FontSize, TimeZoneMode } from './LogLine';
import { ExportDialog, type ExportTarget } from './ExportDialog';
import { Sparkline } from './Sparkline';
import { useLogView } from './useLogView';
import { SavedFilters, type FilterPayload } from './SavedFilters';
import { paneKey, type PaneTarget } from './TailPane';
import { ENV_COLOR } from '../theme';
import { useT, type StringKey, type TFunction } from '../i18n';

const ALL_LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

const LEVEL_PRESETS: { id: string; labelKey?: StringKey; levels: LogLevel[] }[] = [
  { id: 'ERROR', levels: ['ERROR'] },
  { id: 'WARN+', levels: ['ERROR', 'WARN'] },
  { id: 'all', labelKey: 'common.all', levels: [] },
];

/** 레벨 이름은 로그가 쓰는 말이라 옮기지 않는다. 세는 말만 옮긴다. */
function levelLabel(levels: LogLevel[], t: TFunction): string {
  if (levels.length === 0) return t('common.all');
  if (levels.length === 1) return levels[0]!;
  if (levels.length === 2 && levels.includes('ERROR') && levels.includes('WARN')) return 'WARN+';
  return t('common.levelCount', { n: levels.length });
}

/**
 * 조회 창 하나. 구간은 위에서 공유하고 레벨·검색어는 창마다 따로 둔다.
 *
 * 비교의 요점이 '같은 시간대의 다른 로그' 이므로 구간은 공유해야 한다 —
 * 창마다 구간이 다르면 나란히 놓는 의미가 없다.
 */
export function SearchPane({
  target,
  from,
  to,
  runToken,
  timeZone,
  fontSize,
  onClose,
  closable,
}: {
  target: PaneTarget;
  from: Date | null;
  to: Date | null;
  /** 이 값이 바뀌면 조회를 시작한다. 위에서 '조회' 를 누르면 모든 창이 함께 돈다. */
  runToken: number;
  timeZone: TimeZoneMode;
  fontSize: FontSize;
  onClose: () => void;
  closable: boolean;
}) {
  const t = useT();
  const [levels, setLevels] = useState<LogLevel[]>(['ERROR']);
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [envInfo, setEnvInfo] = useState<EnvironmentSummary | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  // 줄에서 pod·thread 를 누르면 그 값으로 거른다. tail 과 같은 동작이다.
  const filterByToken = useCallback((text: string) => {
    setQuery(text);
    setUseRegex(false);
  }, []);

  const s = useSearch();
  const view = useLogView(s.entries, `search:${paneKey(target)}`);

  useEffect(() => {
    void api
      .environments(target.org)
      .then((r) => setEnvInfo(r.environments.find((e) => e.environmentId === target.env) ?? null))
      .catch(() => setEnvInfo(null));
  }, [target.org, target.env]);

  // 위에서 '조회' 를 누를 때마다 돈다. 첫 렌더(runToken 0)에는 돌지 않는다.
  useEffect(() => {
    if (runToken === 0 || !from || !to || to <= from) return;
    view.setSelection(null);
    void s.run({
      org: target.org,
      envId: target.env,
      service: target.service,
      name: target.name,
      from: from.getTime(),
      to: to.getTime(),
      levels,
      query: query.trim() || undefined,
      regex: useRegex || undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runToken]);

  const highlight = useMemo(() => {
    if (query.trim().length === 0) return null;
    try {
      return useRegex ? new RegExp(query, 'gi') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch {
      return null;
    }
  }, [query, useRegex]);

  const isProd = envInfo?.environmentType === 'prod';
  const pct = s.totalBytes > 0 ? Math.min(100, (s.scannedBytes / s.totalBytes) * 100) : 0;

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        border: '1px solid var(--mantine-color-dark-4)',
        borderTop: isProd ? '2px solid var(--mantine-color-red-7)' : '1px solid var(--mantine-color-dark-4)',
      }}
    >
      {/*
        4분할까지 가면 창 하나가 300px 남짓이라 아홉 개가 한 줄에 못 들어간다.
        nowrap 이면 오른쪽 것부터 잘려나가는데, 하필 거기 닫기 버튼이 있어서
        창을 닫을 수가 없었다. 안 들어가면 두 줄로 접는다 — 한 줄 더 쓰는 편이
        버튼이 사라지는 것보다 낫다.
      */}
      <Group
        px={6}
        py={4}
        gap={6}
        wrap="wrap"
        style={{ flexShrink: 0, rowGap: 4, background: 'var(--mantine-color-dark-7)' }}
      >
        {envInfo && (
          <Badge size="xs" variant={isProd ? 'filled' : 'light'} color={ENV_COLOR[envInfo.environmentType] ?? 'gray'}>
            {envInfo.environmentType}
          </Badge>
        )}
        {/*
          창마다 다른 것은 뒤쪽(서비스·로그이름)이다 — 같은 환경의 author 와
          dispatcher 를 나란히 놓는 것이 이 화면의 쓰임이니까. 한 덩어리로 자르면
          하필 그 뒤쪽이 사라져서, 어느 창이 무엇인지 툴팁을 띄워야 알 수 있었다.
          환경 이름만 줄이고 서비스·로그이름은 끝까지 남긴다.
        */}
        <Tooltip label={`${envInfo?.environmentName ?? target.env} · ${target.service} · ${target.name}`} withArrow>
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flexShrink: 1 }}>
            {/* 줄어드는 속도를 8배로 둔다. 좁아지면 환경 이름이 먼저 양보한다 */}
            <Text
              size="xs"
              ff="monospace"
              c="dimmed"
              truncate
              style={{ minWidth: 0, maxWidth: 150, flexShrink: 8 }}
            >
              {envInfo?.environmentName ?? target.env}
            </Text>
            <Text size="xs" ff="monospace" c="dimmed" truncate style={{ minWidth: 0, flexShrink: 1 }}>
              · {target.service} · {target.name}
            </Text>
          </Group>
        </Tooltip>

        <Menu position="bottom-start" withArrow closeOnItemClick={false}>
          <Menu.Target>
            <Button size="compact-xs" variant="default" style={{ minWidth: 62 }}>
              {levelLabel(levels, t)}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('pane.quickPick')}</Menu.Label>
            {LEVEL_PRESETS.map((p) => (
              <Menu.Item key={p.id} onClick={() => setLevels(p.levels)}>
                {p.labelKey ? t(p.labelKey) : p.id}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Label>{t('pane.pickLevels')}</Menu.Label>
            <Box px="sm" pb="xs">
              <Checkbox.Group value={levels} onChange={(v) => setLevels(v as LogLevel[])}>
                <Stack gap={4}>
                  {ALL_LEVELS.map((l) => (
                    <Checkbox key={l} value={l} label={l} size="xs" />
                  ))}
                </Stack>
              </Checkbox.Group>
            </Box>
          </Menu.Dropdown>
        </Menu>

        <TextInput
          size="xs"
          placeholder={t('pane.findHere')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          style={{ flex: '1 1 160px', minWidth: 60, maxWidth: 360 }}
        />
        <Tooltip label={t('pane.regex')} withArrow>
          <Button
            size="compact-xs"
            variant={useRegex ? 'filled' : 'default'}
            color="gray"
            aria-label={t('pane.regexFindAria')}
            aria-pressed={useRegex}
            onClick={() => setUseRegex((v) => !v)}
          >
            .*
          </Button>
        </Tooltip>

        {/*
          남는 폭은 여기가 먹는다. 넓은 화면에서 오른쪽 것들(⋯·건수·닫기)은
          창 모서리에 붙어 있는 편이 찾기 쉽다.
        */}
        <Box style={{ flex: 1, minWidth: 0 }} />

        <Menu position="bottom-end" withArrow closeOnItemClick={false}>
          <Menu.Target>
            <Button
              size="compact-xs"
              variant={view.grouped || view.onlyBookmarked ? 'filled' : 'default'}
              color="gray"
              aria-label={
                view.bookmarks.size > 0
                  ? t('pane.viewAriaBookmarks', { n: view.bookmarks.size })
                  : t('pane.viewAria')
              }
            >
              <span aria-hidden="true">⋯</span>
              {view.grouped && ` −${view.collapsed.toLocaleString()}`}
              {view.bookmarks.size > 0 && ` ★${view.bookmarks.size}`}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>{t('pane.view')}</Menu.Label>
            <Menu.Item onClick={() => view.setGrouped(!view.grouped)}>
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="sm">{t('pane.group')}</Text>
                <Text size="xs" c="dimmed">
                  {view.grouped ? t('pane.groupedLines', { n: view.collapsed }) : t('common.off')}
                </Text>
              </Group>
            </Menu.Item>
            <Menu.Item
              disabled={view.bookmarks.size === 0 && !view.onlyBookmarked}
              onClick={() => view.setOnlyBookmarked(!view.onlyBookmarked)}
            >
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="sm">{t('pane.onlyBookmarked')}</Text>
                <Text size="xs" c="dimmed">
                  {t('common.count', { n: view.bookmarks.size })}
                </Text>
              </Group>
            </Menu.Item>
            <Menu.Item onClick={() => view.setShowChart(!view.showChart)}>
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="sm">{t('pane.chart')}</Text>
                <Text size="xs" c="dimmed">
                  {view.showChart ? t('common.on') : t('common.off')}
                </Text>
              </Group>
            </Menu.Item>
            <Menu.Divider />
            <Box px="sm" pb="xs">
              {/* 구간은 위에서 공유하므로 창에는 레벨·검색어만 저장한다 */}
              <SavedFilters
                current={{ levels, query, regex: useRegex }}
                onApply={(p: FilterPayload) => {
                  if (Array.isArray(p.levels)) setLevels(p.levels as LogLevel[]);
                  if (typeof p.query === 'string') setQuery(p.query);
                  if (typeof p.regex === 'boolean') setUseRegex(p.regex);
                }}
              />
            </Box>
          </Menu.Dropdown>
        </Menu>

        {s.status === 'running' ? (
          <Button size="compact-xs" color="red" variant="light" onClick={() => void s.cancel()}>
            {t('common.cancel')}
          </Button>
        ) : (
          <Text size="xs" c={s.status === 'error' ? 'red' : 'dimmed'} style={{ whiteSpace: 'nowrap' }}>
            {s.status === 'idle' ? '' : t('common.count', { n: s.matched })}
          </Text>
        )}

        {closable && (
          <Tooltip label={t('pane.close')} withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('pane.close')} onClick={onClose}>
              <span aria-hidden="true">✕</span>
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {s.status !== 'idle' && (
        <Box px={6} py={2} style={{ flexShrink: 0, background: 'var(--mantine-color-dark-6)' }}>
          {s.status === 'running' && <Progress value={pct} size="xs" animated />}
          {s.error && (
            <Text size="xs" c="red">
              {s.error}
            </Text>
          )}
          {s.truncated && (
            <Text size="xs" c="yellow">
              {t('search.capped')}
            </Text>
          )}
          {s.skippedDates.length > 0 && (
            <Text size="xs" c="yellow">
              {t('search.skipped', { dates: s.skippedDates.join(', ') })}
            </Text>
          )}
          {s.missingDates.length > 0 && (
            <Text size="xs" c="dimmed">
              {t('search.missing', { dates: s.missingDates.join(', ') })}
            </Text>
          )}
        </Box>
      )}

      {view.showChart && s.entries.length > 0 && (
        <Sparkline entries={s.entries} utc={timeZone === 'UTC'} onSeek={view.setSeekTs} />
      )}

      <Box style={{ flex: 1, minHeight: 0 }}>
        <LogViewer
          entries={view.rows}
          groupCounts={view.groupCounts}
          bookmarks={view.bookmarks}
          onToggleBookmark={view.toggleBookmark}
          seekTs={view.seekTs}
          timeZone={timeZone}
          highlight={highlight}
          fontSize={fontSize}
          onSelectionChange={view.setSelection}
          expandedCount={view.selectedCount}
          onFilterToken={filterByToken}
          selectionActions={() => (
            <Button size="compact-xs" onClick={() => setExportOpen(true)}>
              {t('pane.exportSelection')}
            </Button>
          )}
          empty={
            s.status === 'idle' ? (
              <>
                <Text size="sm">{t('search.idle')}</Text>
                <Text size="xs" c="dimmed">
                  {t('search.idleShared')}
                </Text>
              </>
            ) : s.status === 'running' ? (
              <Text size="sm" c="dimmed">
                {t('search.running')}
              </Text>
            ) : (
              <>
                <Text size="sm">{t('search.empty')}</Text>
                <Text size="xs" c="dimmed">
                  {t('search.emptyHint')}
                </Text>
              </>
            )
          }
        />
      </Box>

      <ExportDialog
        opened={exportOpen}
        onClose={() => setExportOpen(false)}
        lineCount={view.selectedCount}
        target={
          view.selection && s.jobId
            ? ({ source: 'search', jobId: s.jobId, seqs: view.selectedSeqs } satisfies ExportTarget)
            : null
        }
      />
    </Box>
  );
}
