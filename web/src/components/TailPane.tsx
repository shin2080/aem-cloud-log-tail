import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Badge, Box, Button, Checkbox, Group, Loader, Menu, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import type { EnvironmentSummary, LogEntry, LogLevel } from '@shared/types';
import { api } from '../api/client';
import { useTailStream } from '../api/tail';
import { LogViewer } from './LogViewer';
import type { FontSize, TimeZoneMode } from './LogLine';
import { ExportDialog, type ExportTarget } from './ExportDialog';
import { Sparkline } from './Sparkline';
import { SavedFilters, type FilterPayload } from './SavedFilters';
import { useLogView } from './useLogView';
import { ENV_COLOR } from '../theme';
import { useT, type StringKey, type TFunction } from '../i18n';

/** 한 창이 보는 대상. URL 에 `org:env:service:log` 로 직렬화된다. */
export interface PaneTarget {
  org: string;
  env: string;
  service: string;
  name: string;
}

export function paneKey(t: PaneTarget): string {
  return `${t.org}:${t.env}:${t.service}:${t.name}`;
}

export function parsePane(s: string): PaneTarget | null {
  const [org, env, service, name] = s.split(':');
  if (!org || !env || !service || !name) return null;
  return { org, env, service, name };
}

const ALL_LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

/** 빠르게 고르는 조합. 세밀하게 고르려면 드롭다운에서 체크박스를 쓴다. */
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

export function TailPane({
  target,
  timeZone,
  fontSize,
  onClose,
  closable,
}: {
  target: PaneTarget;
  timeZone: TimeZoneMode;
  fontSize: FontSize;
  onClose: () => void;
  closable: boolean;
}) {
  const t = useT();
  const [levels, setLevels] = useState<LogLevel[]>(['ERROR', 'WARN']); // 기본은 WARN+
  const [query, setQuery] = useState('');
  const [useRegex, setUseRegex] = useState(false);
  const [envInfo, setEnvInfo] = useState<EnvironmentSummary | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const params = useMemo(
    () => ({ org: target.org, env: target.env, service: target.service, name: target.name, levels }),
    // levels 는 매번 새 배열이라 내용으로 비교한다. 안 그러면 SSE 가 계속 다시 열린다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target.org, target.env, target.service, target.name, levels.join(',')],
  );

  const tail = useTailStream(params);

  useEffect(() => {
    void api
      .environments(target.org)
      .then((r) => setEnvInfo(r.environments.find((e) => e.environmentId === target.env) ?? null))
      .catch(() => setEnvInfo(null));
  }, [target.org, target.env]);

  const highlight = useMemo(() => {
    if (query.trim().length === 0) return null;
    try {
      return useRegex ? new RegExp(query, 'gi') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch {
      return null;
    }
  }, [query, useRegex]);

  const regexInvalid = useRegex && query.trim().length > 0 && highlight === null;

  const visible = useMemo(() => {
    if (!highlight) return tail.entries;
    return tail.entries.filter((e) => {
      highlight.lastIndex = 0;
      if (highlight.test(e.raw)) return true;
      return e.continuation.some((c) => {
        highlight.lastIndex = 0;
        return highlight.test(c);
      });
    });
  }, [tail.entries, highlight]);

  const view = useLogView(visible, paneKey(target));

  const isProd = envInfo?.environmentType === 'prod';

  return (
    <Box
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        flex: 1,
        border: '1px solid var(--mantine-color-dark-4)',
        // prod 를 보고 있다는 사실이 한눈에 들어와야 오조작이 준다.
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
          placeholder={t('pane.filterHere')}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          error={regexInvalid}
          style={{ flex: '1 1 160px', minWidth: 60, maxWidth: 360 }}
        />
        <Tooltip label={t('pane.regex')} withArrow>
          <Button
            size="compact-xs"
            variant={useRegex ? 'filled' : 'default'}
            color="gray"
            aria-label={t('pane.regexFilterAria')}
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

        {/*
          헤더가 좁다. 창을 넷 열면 각 헤더가 더 좁아진다.
          자주 쓰는 것(레벨·검색·일시정지)만 남기고 보조 기능은 접는다.
        */}
        <Menu position="bottom-end" withArrow closeOnItemClick={false}>
          <Menu.Target>
            <Button
              size="compact-xs"
              variant={view.grouped || view.onlyBookmarked ? 'filled' : 'default'}
              aria-label={
                view.bookmarks.size > 0
                  ? t('pane.viewAriaBookmarks', { n: view.bookmarks.size })
                  : t('pane.viewAria')
              }
              color="gray"
            >
              <span aria-hidden="true">⋯</span>
              {view.grouped && ` −${view.collapsed.toLocaleString()}`}
              {/* 저장된 북마크가 있으면 켜져 있지 않아도 알려준다. 안 그러면 있는 줄도 모른다. */}
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

        <Button
          size="compact-xs"
          variant={tail.paused ? 'filled' : 'default'}
          color={tail.paused ? 'yellow' : 'gray'}
          onClick={() => tail.setPaused(!tail.paused)}
        >
          {tail.paused ? t('pane.resume', { n: tail.pendingCount }) : t('pane.pause')}
        </Button>

        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          {tail.status === 'connecting' && <Loader size={10} />}
          <Text size="xs" c={tail.status === 'error' ? 'red' : 'dimmed'} style={{ whiteSpace: 'nowrap' }}>
            {tail.status === 'open'
              ? tail.entries.length.toLocaleString()
              : tail.status === 'error'
                ? t('pane.disconnected')
                : ''}
          </Text>
          <LagIndicator newestTs={tail.entries[tail.entries.length - 1]?.ts ?? null} />
        </Group>

        {closable && (
          <Tooltip label={t('pane.close')} withArrow>
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('pane.close')} onClick={onClose}>
              <span aria-hidden="true">✕</span>
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      {(tail.error || tail.droppedCount > 0 || tail.rolloverDate) && (
        <Group px={6} py={2} gap="md" style={{ flexShrink: 0, background: 'var(--mantine-color-dark-6)' }}>
          {tail.error && (
            <Text size="xs" c="red">
              {tail.error}
            </Text>
          )}
          {tail.droppedCount > 0 && (
            <Text size="xs" c="yellow">
              {t('pane.dropped', { n: tail.droppedCount })}
            </Text>
          )}
          {tail.rolloverDate && (
            <Text size="xs" c="dimmed">
              {t('pane.rollover', { date: tail.rolloverDate })}
            </Text>
          )}
        </Group>
      )}

      {view.showChart && <Sparkline entries={visible} utc={timeZone === 'UTC'} onSeek={view.setSeekTs} />}

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
          selectionActions={() => (
            <>
              <CopySelectionButton entries={view.rows.filter((e) => view.selectedSeqSet.has(e.seq))} />
              <Button size="compact-xs" onClick={() => setExportOpen(true)}>
                {t('pane.exportSelection')}
              </Button>
            </>
          )}
          empty={
            tail.status === 'connecting' ? (
              <>
                <Loader size="sm" />
                <Text size="sm" c="dimmed">
                  {t('pane.opening')}
                </Text>
              </>
            ) : query.trim().length > 0 ? (
              <>
                <Text size="sm">{t('pane.noMatch')}</Text>
                <Text size="xs" c="dimmed">
                  {t('pane.noMatchHint')}
                </Text>
              </>
            ) : (
              <>
                <Text size="sm">
                  {t('pane.noneYet', {
                    levels: levels.length === 0 ? t('pane.noneYetAny') : levels.join('/'),
                  })}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('pane.noneYetHint')}
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
          view.selection
            ? ({ source: 'tail', sessionId: paneKey(target), seqs: view.selectedSeqs } satisfies ExportTarget)
            : null
        }
      />
    </Box>
  );
}

/**
 * 선택 구간을 클립보드로. 슬랙이나 이슈에 붙일 때는 파일보다 이쪽이 편하다.
 * 마스킹은 이미 적용된 상태라 원문이 나갈 일은 없다.
 */
function CopySelectionButton({ entries }: { entries: LogEntry[] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    const text = entries
      .map((e) => [e.raw, ...e.continuation].join('\n'))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 비보안 컨텍스트(HTTP)에서는 clipboard API 가 막힌다. 조용히 실패하지 않게 알린다.
      setCopied(false);
      window.prompt(t('copy.blocked'), text.slice(0, 5000));
    }
  };

  return (
    <Button size="compact-xs" variant="default" onClick={() => void copy()}>
      {copied ? t('common.copied') : t('common.copy')}
    </Button>
  );
}

/**
 * 가장 최근 로그가 얼마나 오래됐는지 보여준다.
 *
 * AEM 이 로그를 스토리지로 흘리는 데 실측 2분쯤 걸린다 (docs/findings.md).
 * 이걸 안 보여주면 방금 만든 에러가 화면에 없을 때 도구가 고장난 줄 안다.
 */
function LagIndicator({ newestTs }: { newestTs: number | null }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (newestTs === null) return null;

  const ageSec = Math.max(0, Math.round((now - newestTs) / 1000));
  const label =
    ageSec < 60
      ? t('age.sec', { n: ageSec })
      : t('age.minSec', { m: Math.floor(ageSec / 60), s: ageSec % 60 });
  const stale = ageSec > 180;

  return (
    <Tooltip
      label={t('age.tip') + (stale ? t('age.stale') : '')}
      withArrow
      multiline
      w={260}
    >
      <Text size="xs" c={stale ? 'yellow' : 'dimmed'} style={{ whiteSpace: 'nowrap', cursor: 'default' }}>
        {t('age.ago', { label })}
      </Text>
    </Tooltip>
  );
}
