import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry } from '@shared/types';
import { collapsedCount, groupEntries, type GroupedEntry } from '../lib/grouping';
import { useThrottled } from '../lib/useThrottled';
import type { SelectionRange } from './LogViewer';

export interface LogViewState {
  /** 화면에 실제로 그릴 줄 */
  rows: LogEntry[];
  /** seq → 묶인 건수 (묶기가 켜졌을 때만) */
  groupCounts: Map<number, number> | undefined;
  /** 묶어서 줄어든 줄 수 */
  collapsed: number;

  grouped: boolean;
  setGrouped: (v: boolean) => void;
  showChart: boolean;
  setShowChart: (v: boolean) => void;

  bookmarks: Set<number>;
  toggleBookmark: (seq: number) => void;
  onlyBookmarked: boolean;
  setOnlyBookmarked: (v: boolean) => void;

  seekTs: number | null;
  setSeekTs: (t: number | null) => void;

  selection: SelectionRange | null;
  setSelection: (s: SelectionRange | null) => void;
  /** 선택된 '보이는' 줄 수. 대화상자가 말하는 숫자다 */
  selectedCount: number;
  /**
   * 실제로 내보낼 seq 목록.
   * 묶기에서는 묶인 것들을 전부 편다 — ×523 을 골랐으면 523줄이 나가야 한다.
   */
  selectedSeqs: number[];
  /** 위와 같은 내용. 화면에서 걸러낼 때 Array.includes 로 훑으면 곱셈이 된다 */
  selectedSeqSet: Set<number>;
}

/**
 * tail 과 조회가 함께 쓰는 뷰 상태.
 *
 * 묶기·북마크·분포를 한쪽에만 넣으면 두 화면의 성격이 갈린다.
 * 조회야말로 묶기가 가장 필요한 곳이다 — 몇 시간치 ERROR 는 같은 예외가 수천 건이다.
 */
/**
 * 북마크를 브라우저에 남긴다.
 *
 * "밀려나도 남는다" 고 해놓고 새로고침에 날아가면 말이 안 된다.
 * scope 는 창의 대상(org:env:service:log) 이라 창마다 따로 기억한다.
 * seq 는 서버 세션이 다시 시작하면 0부터라 엔트리 자체도 함께 저장한다.
 */
function loadBookmarks(scope: string): { seqs: number[]; pinned: [number, LogEntry][] } {
  try {
    const raw = localStorage.getItem(`aclv.bookmarks.${scope}`);
    if (!raw) return { seqs: [], pinned: [] };
    const parsed = JSON.parse(raw) as { seqs?: number[]; pinned?: [number, LogEntry][] };
    return { seqs: parsed.seqs ?? [], pinned: parsed.pinned ?? [] };
  } catch {
    return { seqs: [], pinned: [] };
  }
}

function saveBookmarks(scope: string, seqs: Set<number>, pinned: Map<number, LogEntry>): void {
  try {
    if (seqs.size === 0) {
      localStorage.removeItem(`aclv.bookmarks.${scope}`);
      return;
    }
    localStorage.setItem(
      `aclv.bookmarks.${scope}`,
      JSON.stringify({ seqs: [...seqs], pinned: [...pinned.entries()] }),
    );
  } catch {
    // 용량 초과나 사생활 보호 모드. 이번 세션에는 그대로 동작한다.
  }
}

export function useLogView(entries: LogEntry[], scope = 'default'): LogViewState {
  const [grouped, setGrouped] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [bookmarks, setBookmarks] = useState<Set<number>>(new Set());
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  const [seekTs, setSeekTs] = useState<number | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);

  /**
   * 북마크한 줄은 링버퍼에서 밀려나도 여기 남는다.
   * 로그가 메모리에만 있으므로 표시해둔 줄을 붙잡아 두려면 이게 필요하다.
   */
  const [pinned, setPinned] = useState<Map<number, LogEntry>>(new Map());

  // 창을 열 때 되살리고, 바뀔 때마다 남긴다.
  useEffect(() => {
    const saved = loadBookmarks(scope);
    setBookmarks(new Set(saved.seqs));
    setPinned(new Map(saved.pinned));
  }, [scope]);

  useEffect(() => {
    saveBookmarks(scope, bookmarks, pinned);
  }, [scope, bookmarks, pinned]);

  /**
   * 북마크 토글이 `entries` 에 의존하면 SSE 배치마다 함수가 새로 만들어진다.
   * 그 함수는 모든 LogLine 의 prop 이라, memo 를 걸어둔 게 매번 깨지고
   * 보이는 줄 전부가 다시 그려진다. 최신 목록은 ref 로 본다.
   */
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const toggleBookmark = useCallback((seq: number) => {
    setBookmarks((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
    setPinned((prev) => {
      const next = new Map(prev);
      if (next.has(seq)) next.delete(seq);
      else {
        const e = entriesRef.current.find((x) => x.seq === seq);
        if (e) next.set(seq, e);
      }
      return next;
    });
  }, []);

  /**
   * 묶기는 5만 엔트리에서 한 번에 40ms 남짓 걸린다. 배치마다 다시 하면 화면이 멈춘다.
   * 켜져 있을 때만 반 초 간격으로 흘린다. 꺼져 있으면 지연 없이 그대로 쓴다.
   */
  const groupingInput = useThrottled(entries, 500, grouped);

  const { rows, groups, groupCounts, collapsed } = useMemo(() => {
    let base = grouped ? groupingInput : entries;

    if (onlyBookmarked) {
      // 밀려난 줄도 북마크했으면 보여준다.
      const byId = new Map(base.filter((e) => bookmarks.has(e.seq)).map((e) => [e.seq, e]));
      for (const [seq, e] of pinned) if (bookmarks.has(seq) && !byId.has(seq)) byId.set(seq, e);
      base = [...byId.values()].sort((a, b) => a.seq - b.seq);
    }

    if (!grouped) {
      return { rows: base, groups: null, groupCounts: undefined, collapsed: 0 };
    }

    const gs = groupEntries(base);
    return {
      rows: gs.map((g) => g.entry),
      groups: gs,
      groupCounts: new Map(gs.map((g) => [g.entry.seq, g.count])),
      collapsed: collapsedCount(base, gs),
    };
  }, [entries, groupingInput, grouped, onlyBookmarked, bookmarks, pinned]);

  const { selectedCount, selectedSeqs, selectedSeqSet } = useMemo(() => {
    if (!selection) return { selectedCount: 0, selectedSeqs: [] as number[], selectedSeqSet: new Set<number>() };

    const picked = rows.filter((e) => e.seq >= selection.fromSeq && e.seq <= selection.toSeq);

    // 묶기에서는 대표 줄 뒤에 숨은 것들까지 전부 내보낸다.
    const seqs = groups
      ? expandGroups(groups, picked)
      : picked.map((e) => e.seq);

    return { selectedCount: seqs.length, selectedSeqs: seqs, selectedSeqSet: new Set(seqs) };
  }, [selection, rows, groups]);

  return {
    rows,
    groupCounts,
    collapsed,
    grouped,
    setGrouped,
    showChart,
    setShowChart,
    bookmarks,
    toggleBookmark,
    onlyBookmarked,
    setOnlyBookmarked,
    seekTs,
    setSeekTs,
    selection,
    setSelection,
    selectedCount,
    selectedSeqs,
    selectedSeqSet,
  };
}

function expandGroups(groups: GroupedEntry[], picked: LogEntry[]): number[] {
  const wanted = new Set(picked.map((e) => e.seq));
  const out: number[] = [];
  for (const g of groups) if (wanted.has(g.entry.seq)) out.push(...g.seqs);
  return out.sort((a, b) => a - b);
}
