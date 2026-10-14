import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Center, Group, Stack, Text } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LogEntry } from '@shared/types';
import { LogLine, type FontSize, type TimeZoneMode } from './LogLine';
import { useT } from '../i18n';

export interface SelectionRange {
  fromSeq: number;
  toSeq: number;
}

export interface LogViewerProps {
  entries: LogEntry[];
  /** seq → 묶인 건수. 묶어보기에서만 채운다 */
  groupCounts?: Map<number, number>;
  bookmarks?: Set<number>;
  onToggleBookmark?: (seq: number) => void;
  /** 히스토그램에서 시각을 누르면 그리로 이동한다 */
  seekTs?: number | null;
  timeZone: TimeZoneMode;
  highlight: RegExp | null;
  fontSize: FontSize;
  /** 비어 있을 때 보여줄 안내. 다음 행동을 지시해야 한다. */
  empty: React.ReactNode;
  /** 선택 구간이 바뀔 때. 넘기지 않으면 범위 선택이 꺼진다 */
  onSelectionChange?: (sel: SelectionRange | null) => void;
  /** 선택 구간에 대해 띄울 액션 바 */
  selectionActions?: (sel: SelectionRange, count: number) => React.ReactNode;
  /**
   * 실제로 다뤄질 줄 수. 묶어보기에서는 화면의 한 줄이 여러 줄을 대표하므로
   * 보이는 줄 수와 다르다. 액션바가 거짓말하지 않게 부모가 알려준다.
   */
  expandedCount?: number;
  /** pod·thread 를 누르면 그 값으로 거른다. 넘기지 않으면 그냥 글자다 */
  onFilterToken?: (text: string) => void;
  /** 펼쳐둔 스택트레이스. 줄 안의 상태로 두면 스크롤로 벗어났다 오면 접혀 있다 */
  expanded?: Set<number>;
  onToggleExpand?: (seq: number) => void;
}

/** 이 픽셀 안쪽이면 '바닥에 붙어 있다'고 본다. */
const STICK_THRESHOLD_PX = 40;

/**
 * 5만 라인을 DOM 에 그리면 브라우저가 죽는다. 가상 스크롤은 선택이 아니다.
 * 스택트레이스 펼침 때문에 라인 높이가 가변이라 measureElement 를 쓴다.
 */
export function LogViewer({
  entries,
  timeZone,
  highlight,
  fontSize,
  empty,
  onSelectionChange,
  selectionActions,
  groupCounts,
  bookmarks,
  onToggleBookmark,
  seekTs,
  expandedCount,
  onFilterToken,
  expanded,
  onToggleExpand,
}: LogViewerProps) {
  const t = useT();
  const parentRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastCount = useRef(entries.length);

  /**
   * 범위 선택. 시작 줄을 누르고 Shift+누르면 끝이 잡힌다.
   * 이게 이 도구의 시그니처 인터랙션이다 — 파일 전체를 받는 게 아니라
   * 눈으로 보고 필요한 만큼만 집어간다.
   */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  // 상태와 별도로 ref 를 둔다. 스크롤 핸들러가 낡은 클로저를 보면 추적이 끊긴다.
  const stickRef = useRef(true);
  const setStickBoth = useCallback((v: boolean) => {
    stickRef.current = v;
    setStick(v);
  }, []);

  const pick = useCallback(
    (seq: number, shift: boolean) => {
      if (!onSelectionChange) return;
      // 고르기 시작하면 따라가기를 멈춘다. 안 그러면 고른 줄이 새 로그에 밀려 올라간다.
      setStickBoth(false);
      if (shift && anchor !== null) {
        const next = { fromSeq: Math.min(anchor, seq), toSeq: Math.max(anchor, seq) };
        setSelection(next);
        onSelectionChange(next);
        return;
      }
      // 같은 줄을 다시 누르면 선택을 푼다.
      if (selection && selection.fromSeq === seq && selection.toSeq === seq) {
        setAnchor(null);
        setSelection(null);
        onSelectionChange(null);
        return;
      }
      setAnchor(seq);
      const next = { fromSeq: seq, toSeq: seq };
      setSelection(next);
      onSelectionChange(next);
    },
    [anchor, selection, onSelectionChange, setStickBoth],
  );

  const clearSelection = useCallback(() => {
    setAnchor(null);
    setSelection(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  // 메모 없이 두면 SSE 배치마다(초당 10회) 전체를 훑는다. 선택은 대개 없거나 몇 줄이다.
  const selectedCount = useMemo(() => {
    if (!selection) return 0;
    let n = 0;
    for (const e of entries) if (e.seq >= selection.fromSeq && e.seq <= selection.toSeq) n++;
    return n;
  }, [entries, selection]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 22,
    overscan: 24,
    getItemKey: (i) => entries[i]?.seq ?? i,
  });

  /**
   * react-virtual 이 측정한 높이를 담아두는 Map 을 주기적으로 훑어낸다.
   *
   * 이 캐시는 getItemKey 가 돌려준 키(여기서는 seq)로 쌓이고, 라이브러리는
   * `enabled` 가 꺼질 때 말고는 지우지 않는다. 링버퍼에서 밀려난 줄의 키도 그대로 남아,
   * 하루 종일 켜두면 이 Map 하나가 수백 MB 로 자란다. 몇 시간 쓰다 닫으면 안 보이고
   * 모니터에 걸어둬야 보이는 종류의 누수라, 여기서 직접 치운다.
   *
   * 살아 있는 키만 남기므로 측정값은 그대로다 — 다시 재는 일도 없다.
   */
  const pruneMeasurementCache = useCallback(() => {
    const cache = (virtualizer as unknown as { itemSizeCache?: unknown }).itemSizeCache;
    // 라이브러리가 바뀌어 이 필드가 사라졌다면 조용히 넘어간다. 화면이 죽을 일은 아니다.
    if (!(cache instanceof Map)) return;
    // 밀려난 만큼이 쌓였을 때만 훑는다. 배치마다 하면 그게 더 비싸다.
    if (cache.size <= entries.length * 2 + 1000) return;

    const live = new Set(entries.map((e) => e.seq));
    for (const key of [...cache.keys()]) if (!live.has(key as number)) cache.delete(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  useEffect(pruneMeasurementCache, [pruneMeasurementCache]);


  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickBoth(true);
    setUnseen(0);
  }, [setStickBoth]);

  /**
   * 자동 추적. 바닥에 붙어 있으면 새 로그를 따라가고,
   * 사용자가 위로 스크롤하면 멈추고 "새 로그 N건" 버튼을 띄운다.
   */
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
    if (atBottom !== stickRef.current) setStickBoth(atBottom);
    if (atBottom) setUnseen(0);
  }, [setStickBoth]);

  useLayoutEffect(() => {
    const added = entries.length - lastCount.current;
    lastCount.current = entries.length;
    if (added > 0 && !stickRef.current) setUnseen((n) => n + added);
  }, [entries.length]);

  /**
   * 라인 높이가 가변이라 measureElement 가 그린 뒤에 총 높이를 바꾼다.
   * 그 순간 바닥에서 밀려나 추적이 저절로 풀리므로, 총 높이가 바뀔 때마다 다시 붙인다.
   */
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    if (!stickRef.current) return;
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [totalSize, entries.length]);

  // 뷰어가 처음 붙을 때 바닥에서 시작한다.
  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 히스토그램에서 시각을 누르면 그 시각 이후 첫 줄로 간다. */
  useEffect(() => {
    if (seekTs === null || seekTs === undefined) return;
    const i = entries.findIndex((e) => e.ts >= seekTs);
    if (i < 0) return;
    setStickBoth(false);
    virtualizer.scrollToIndex(i, { align: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTs]);

  if (entries.length === 0) {
    return (
      <Center h="100%" p="xl">
        <Stack gap={4} align="center" maw={480}>
          {empty}
        </Stack>
      </Center>
    );
  }

  const items = virtualizer.getVirtualItems();

  return (
    <Box style={{ position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box
        ref={parentRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', contain: 'strict' }}
      >
        <Box style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {items.map((v) => (
            <Box
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${v.start}px)` }}
            >
              <LogLine
                entry={entries[v.index]!}
                timeZone={timeZone}
                highlight={highlight}
                fontSize={fontSize}
                groupCount={groupCounts?.get(entries[v.index]!.seq)}
                bookmarked={bookmarks?.has(entries[v.index]!.seq)}
                onToggleBookmark={onToggleBookmark}
                selected={
                  selection !== null &&
                  entries[v.index]!.seq >= selection.fromSeq &&
                  entries[v.index]!.seq <= selection.toSeq
                }
                onPick={onSelectionChange ? pick : undefined}
                onFilterToken={onFilterToken}
                expanded={expanded?.has(entries[v.index]!.seq)}
                onToggleExpand={onToggleExpand}
              />
            </Box>
          ))}
        </Box>
      </Box>

      {!stick && (
        <Button
          size="compact-sm"
          variant="filled"
          color="gray"
          onClick={scrollToBottom}
          style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 2 }}
        >
          {unseen > 0 ? t('viewer.newLines', { n: unseen }) : t('viewer.toBottom')}
        </Button>
      )}

      {stick && !selection && (
        <Text
          size="xs"
          c="dimmed"
          style={{ position: 'absolute', bottom: 6, right: 12, zIndex: 2, pointerEvents: 'none' }}
        >
          {t('viewer.following')}
        </Text>
      )}

      {selection && selectionActions && (
        <Group
          gap="sm"
          px="sm"
          py={6}
          wrap="nowrap"
          // 절대배치로 띄우면 선택 구간의 마지막 줄을 가린다. 자리를 차지하게 둔다.
          style={{
            flexShrink: 0,
            background: 'var(--mantine-color-dark-6)',
            borderTop: '1px solid var(--mantine-color-dark-4)',
          }}
        >
          <Text size="sm" fw={500} style={{ whiteSpace: 'nowrap' }}>
            {expandedCount !== undefined && expandedCount !== selectedCount
              ? t('viewer.selectedGroups', { groups: selectedCount, lines: expandedCount })
              : t('viewer.selectedLines', { n: selectedCount })}
          </Text>
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {anchor !== null && selection.fromSeq === selection.toSeq
              ? t('viewer.shiftHint')
              : `seq ${selection.fromSeq} ~ ${selection.toSeq}`}
          </Text>
          <Box style={{ flex: 1 }} />
          {selectionActions(selection, selectedCount)}
          <Button size="compact-xs" variant="subtle" color="gray" onClick={clearSelection}>
            {t('viewer.clearSelection')}
          </Button>
        </Group>
      )}
    </Box>
  );
}
