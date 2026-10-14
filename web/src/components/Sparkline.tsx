import { useMemo } from 'react';
import { Box, Tooltip } from '@mantine/core';
import type { LogEntry } from '@shared/types';
import { buildHistogram, bucketWidthMs } from '../lib/histogram';
import { useThrottled } from '../lib/useThrottled';
import { useT } from '../i18n';

const HEIGHT = 22;
const KST_OFFSET_MS = 9 * 3600_000;

function hhmm(ms: number, utc: boolean): string {
  const d = new Date(utc ? ms : ms + KST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/**
 * 버퍼 전체의 시간축 분포. 스크롤로 훑는 것보다 '언제 터졌나' 를 훨씬 빨리 찾는다.
 *
 * 색은 ERROR 에만 쓴다 — 뷰어의 규칙과 같다. WARN 은 중간 톤, 나머지는 배경에 가깝다.
 * 막대를 누르면 그 시각으로 이동한다.
 */
export function Sparkline({
  entries,
  utc,
  onSeek,
  canSeekAll = false,
}: {
  entries: LogEntry[];
  utc: boolean;
  /** 막대를 누르면. `all` 은 Shift 를 누른 채였다는 뜻이다 — 모든 창을 이 시각으로 */
  onSeek?: (ts: number, all: boolean) => void;
  /** 창이 둘 이상이라 '모든 창' 이 의미가 있을 때만 툴팁에 안내를 붙인다 */
  canSeekAll?: boolean;
}) {
  const t = useT();
  // 요약 그래프라 1초 늦어도 티가 안 난다. 배치마다 5만 건을 다시 세지 않는다.
  const throttled = useThrottled(entries, 1000);
  const buckets = useMemo(() => buildHistogram(throttled), [throttled]);

  const max = useMemo(() => {
    let m = 0;
    for (const b of buckets) m = Math.max(m, b.error + b.warn + b.other);
    return m;
  }, [buckets]);

  if (buckets.length === 0) return null;
  const width = bucketWidthMs(buckets);

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 1,
        height: HEIGHT,
        padding: '2px 6px',
        background: 'var(--mantine-color-dark-8)',
        borderBottom: '1px solid var(--mantine-color-dark-5)',
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      {buckets.map((b) => {
        const total = b.error + b.warn + b.other;
        const h = max === 0 ? 0 : Math.max(1, Math.round(((HEIGHT - 6) * total) / max));
        const label =
          `${hhmm(b.t, utc)}–${hhmm(b.t + width, utc)}  ` +
          [b.error && `ERROR ${b.error}`, b.warn && `WARN ${b.warn}`, b.other && `${t('chart.other')} ${b.other}`]
            .filter(Boolean)
            .join(' · ');

        return (
          <Tooltip
            key={b.t}
            label={canSeekAll && onSeek ? `${label}  ·  ${t('chart.seekAll')}` : label}
            withArrow
            openDelay={200}
            position="bottom"
          >
            <Box
              onClick={(e) => onSeek?.(b.t, e.shiftKey)}
              style={{
                flex: 1,
                minWidth: 2,
                height: h,
                cursor: onSeek ? 'pointer' : 'default',
                display: 'flex',
                flexDirection: 'column-reverse',
              }}
            >
              {/* ERROR 를 아래에 깔아 눈에 먼저 들어오게 한다 */}
              {b.error > 0 && <Box style={{ height: `${(b.error / total) * 100}%`, background: 'var(--mantine-color-red-6)' }} />}
              {b.warn > 0 && <Box style={{ height: `${(b.warn / total) * 100}%`, background: 'var(--mantine-color-yellow-7)' }} />}
              {b.other > 0 && <Box style={{ height: `${(b.other / total) * 100}%`, background: 'var(--mantine-color-dark-3)' }} />}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
