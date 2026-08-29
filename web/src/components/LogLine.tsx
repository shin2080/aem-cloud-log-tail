import { memo, useState } from 'react';
import { Badge, Box, Group, Text, Tooltip, UnstyledButton } from '@mantine/core';
import type { LogEntry, LogLevel } from '@shared/types';
import { useT, type StringKey } from '../i18n';

/**
 * 로그 뷰어에서 모든 줄이 알록달록하면 아무것도 안 보인다.
 * 강조는 ERROR 한 곳에만 쓴다. WARN 은 중간, 나머지는 배경과 거의 같은 톤.
 */
const LEVEL_STYLE: Record<LogLevel, { color: string; variant: 'filled' | 'light' | 'transparent' }> = {
  ERROR: { color: 'red', variant: 'filled' },
  WARN: { color: 'yellow', variant: 'light' },
  INFO: { color: 'gray', variant: 'transparent' },
  DEBUG: { color: 'gray', variant: 'transparent' },
  TRACE: { color: 'gray', variant: 'transparent' },
  UNKNOWN: { color: 'gray', variant: 'transparent' },
};

export type TimeZoneMode = 'KST' | 'UTC';

/** 로그 본문 글자 크기. 한 화면에 보이는 줄 수가 달라진다. */
export type FontSize = 'xs' | 'sm' | 'md' | 'lg';

export const FONT_PX: Record<FontSize, number> = { xs: 10, sm: 11, md: 12, lg: 14 };
/** 글자 크기 이름. 값이 아니라 문자열 키다 — 쓰는 쪽에서 t() 로 옮긴다. */
export const FONT_LABEL: Record<FontSize, StringKey> = {
  xs: 'font.xs',
  sm: 'font.sm',
  md: 'font.md',
  lg: 'font.lg',
};

function formatTime(ts: number, mode: TimeZoneMode): string {
  const d = new Date(mode === 'UTC' ? ts : ts + 9 * 3600_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}

/** 'com.adobe.cq.dam.core.impl.AssetImpl' -> 'c.a.c.d.c.i.AssetImpl' */
function shortenLogger(logger: string): string {
  const parts = logger.split('.');
  if (parts.length <= 2) return logger;
  return parts.map((p, i) => (i === parts.length - 1 ? p : p.charAt(0))).join('.');
}

export interface LogLineProps {
  entry: LogEntry;
  timeZone: TimeZoneMode;
  /** 하이라이트할 검색어 (정규식 아님 — 이미 만들어진 RegExp 를 받는다) */
  highlight: RegExp | null;
  fontSize: FontSize;
  selected: boolean;
  /** 범위 선택. shift 를 누른 채 누르면 구간이 잡힌다 */
  onPick?: (seq: number, shift: boolean) => void;
  /** 묶어보기에서 같은 사건이 몇 건인지. 1이면 배지를 달지 않는다 */
  groupCount?: number;
  bookmarked?: boolean;
  onToggleBookmark?: (seq: number) => void;
}

function highlightText(text: string, re: RegExp | null) {
  if (!re || text.length === 0) return text;
  const parts: (string | JSX.Element)[] = [];
  let last = 0;
  let n = 0;
  // 전역 정규식의 lastIndex 를 건드리지 않도록 복사해 쓴다.
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of text.matchAll(g)) {
    if (m.index === undefined || m[0].length === 0) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      // light-dark() 로 두 테마에서 모두 대비가 나오게 한다. yellow-9 고정이면 라이트에서 안 읽힌다.
      <mark
        key={n++}
        style={{
          background: 'light-dark(var(--mantine-color-yellow-3), var(--mantine-color-yellow-9))',
          color: 'inherit',
          padding: 0,
        }}
      >
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export const LogLine = memo(function LogLine({
  entry,
  timeZone,
  highlight,
  fontSize,
  selected,
  onPick,
  groupCount,
  bookmarked,
  onToggleBookmark,
}: LogLineProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const style = LEVEL_STYLE[entry.level];
  const hasStack = entry.continuation.length > 0;
  const px = FONT_PX[fontSize];

  return (
    <Box
      px="xs"
      py={2}
      onMouseDown={(e) => {
        // 텍스트를 드래그로 복사하는 것과 겹치지 않게 shift 클릭만 기본동작을 막는다.
        if (e.shiftKey) e.preventDefault();
        onPick?.(entry.seq, e.shiftKey);
      }}
      style={{
        fontFamily: 'var(--mantine-font-family-monospace)',
        fontSize: px,
        lineHeight: 1.5,
        cursor: onPick ? 'pointer' : undefined,
        background: selected ? 'var(--mantine-color-blue-9)' : undefined,
        borderLeft: entry.level === 'ERROR' ? '2px solid var(--mantine-color-red-7)' : '2px solid transparent',
      }}
    >
      <Group gap={8} wrap="nowrap" align="flex-start">
        <Text span c="dimmed" style={{ flexShrink: 0, fontSize: px, fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(entry.ts, timeZone)}
        </Text>

        <Badge
          size="xs"
          radius="sm"
          color={style.color}
          variant={style.variant}
          // Mantine Badge 의 기본 좌우 패딩을 없애야 'ERROR' 가 안 잘린다.
          // 너비는 글자 크기를 따라가되, 열이 어긋나지 않게 고정폭으로 둔다.
          style={{
            flexShrink: 0,
            width: 4.6 * Math.max(8, px - 3),
            padding: 0,
            fontSize: Math.max(8, px - 3),
            letterSpacing: 0,
          }}
        >
          {entry.level === 'UNKNOWN' ? '·' : entry.level}
        </Badge>

        {entry.logger && (
          <Tooltip label={entry.logger} openDelay={400} withArrow>
            <Text span c="dimmed" style={{ flexShrink: 0, fontSize: px, cursor: 'default' }}>
              {shortenLogger(entry.logger)}
            </Text>
          </Tooltip>
        )}

        {/*
          Mantine Text 는 부모의 font-size 를 상속하지 않고 size prop 의 기본값(md)을 쓴다.
          여기에 크기를 명시하지 않으면 글자 크기 조절이 본문에는 안 먹고
          시각·로거만 줄어들어 한 줄 안에서 크기가 어긋난다.
        */}
        <Text
          span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: px,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: entry.level === 'ERROR' ? 'var(--mantine-color-red-2)' : undefined,
          }}
        >
          {highlightText(entry.message || entry.raw, highlight)}
        </Text>

        {onToggleBookmark && (
          <Tooltip label={bookmarked ? t('line.unbookmark') : t('line.bookmarkTip')} withArrow>
            <UnstyledButton
              aria-label={bookmarked ? t('line.unbookmark') : t('line.bookmark')}
              aria-pressed={bookmarked}
              onClick={(ev) => {
                ev.stopPropagation();
                onToggleBookmark(entry.seq);
              }}
              style={{
                flexShrink: 0,
                fontSize: px,
                lineHeight: 1,
                color: bookmarked ? 'var(--mantine-color-yellow-5)' : undefined,
                opacity: bookmarked ? 1 : 0.4,
              }}
            >
              {bookmarked ? '★' : '☆'}
            </UnstyledButton>
          </Tooltip>
        )}

        {groupCount !== undefined && groupCount > 1 && (
          <Tooltip label={t('line.grouped', { n: groupCount })} withArrow>
            <Badge size="xs" variant="filled" color="gray" style={{ flexShrink: 0, fontSize: Math.max(8, px - 3) }}>
              ×{groupCount.toLocaleString()}
            </Badge>
          </Tooltip>
        )}

        {entry.masked && (
          <Tooltip label={t('line.masked')} withArrow>
            <Badge size="xs" variant="outline" color="gray" style={{ flexShrink: 0, fontSize: Math.max(8, px - 3) }}>
              masked
            </Badge>
          </Tooltip>
        )}
      </Group>

      {hasStack && (
        <Box pl={6.5 * px}>
          <UnstyledButton
            aria-label={
              open
                ? t('line.collapseAria', { n: entry.continuation.length })
                : t('line.expandAria', { n: entry.continuation.length })
            }
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          >
            <Text span c="dimmed" style={{ fontSize: px - 1 }}>
              {open ? '▾' : '▸'} {t('line.stack', { n: entry.continuation.length })}
            </Text>
          </UnstyledButton>
          {open && (
            <Box
              mt={2}
              py={4}
              px="xs"
              style={{
                background: 'var(--mantine-color-dark-8)',
                borderRadius: 2,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: px - 1,
                color: 'var(--mantine-color-dimmed)',
              }}
            >
              {entry.continuation.join('\n')}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
});
