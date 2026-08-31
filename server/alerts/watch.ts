import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { LogEntry } from '../../shared/types.js';
import { signatureOf } from '../../shared/signature.js';
import { alertHits, alertRules, type AlertRuleRow } from '../db/schema.js';
import { checkEnvAccess } from '../auth/authz.js';
import { resolveSession } from '../auth/session.js';
import { tailKeyOf, type TailEvent, type TailKey } from '../tail/session.js';
import { compileRule, PatternError, type CompiledRule } from './matcher.js';
import type { LogLevel } from '../../shared/types.js';

/** 새 히트가 생겼을 때 열려 있는 화면으로 밀어주기 위한 것 */
export interface HitEvent {
  hitId: string;
  ruleId: string;
  ruleName: string;
  userId: string;
  orgKey: string;
  environmentId: string;
  service: string;
  logName: string;
  level: string;
  count: number;
  lastTs: number;
  lastSeq: number;
}

type HitListener = (e: HitEvent) => void;

interface Watched {
  key: TailKey;
  unsubscribe: () => void;
  /** 이 대상에 걸린 규칙들. 규칙이 바뀌면 통째로 다시 만든다 */
  rules: { row: AlertRuleRow; compiled: CompiledRule }[];
}

/** 권한 재확인 주기. 열린 SSE 와 같은 이유다 — 회수가 반영되지 않으면 회수가 아니다. */
const RECHECK_INTERVAL_MS = 60_000;

function targetOf(r: AlertRuleRow): TailKey {
  return { orgKey: r.orgKey, environmentId: r.environmentId, service: r.service, logName: r.logName };
}

function parseLevels(raw: string | null): LogLevel[] | null {
  if (!raw) return null;
  const out = raw.split(',').map((s) => s.trim()).filter(Boolean) as LogLevel[];
  return out.length > 0 ? out : null;
}

/**
 * 규칙이 걸린 대상을 아무도 안 보고 있어도 따라간다.
 *
 * 레지스트리를 고치지 않는다 — 브라우저와 똑같은 구독자로 붙잡고 있을 뿐이다.
 * 그래서 롤오버·서명 URL 갱신·재연결이 전부 공짜로 따라온다.
 *
 * 대신 대상 하나가 곧 영구 폴링 루프 + 링버퍼다. 그게 이 기능의 비용이고,
 * ALERT_MAX_TARGETS 가 그 상한이다.
 */
export class AlertWatcher {
  private readonly watched = new Map<string, Watched>();
  private readonly listeners = new Set<HitListener>();
  private recheck: NodeJS.Timeout | null = null;
  /** 규칙+지문별 마지막 알림 시각. 재시작 뒤 폭탄을 막으려고 DB 에서 되살린다 */
  private readonly lastFired = new Map<string, number>();

  constructor(private readonly ctx: AppContext) {}

  get watchedCount(): number {
    return this.watched.size;
  }

  get watchedTargets(): string[] {
    return [...this.watched.keys()];
  }

  subscribe(fn: HitListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async start(): Promise<void> {
    await this.sync();
    this.recheck = setInterval(() => void this.sync(), RECHECK_INTERVAL_MS);
    this.recheck.unref();
  }

  stop(): void {
    if (this.recheck) clearInterval(this.recheck);
    this.recheck = null;
    for (const w of this.watched.values()) w.unsubscribe();
    this.watched.clear();
    this.listeners.clear();
  }

  /**
   * DB 의 규칙과 실제 구독을 맞춘다. 규칙이 바뀔 때마다, 그리고 주기적으로 부른다.
   *
   * 주기적으로도 도는 이유는 권한 때문이다. 규칙을 만든 뒤 조직 접근이 회수되거나
   * 계정이 꺼질 수 있는데, 그때 규칙이 계속 돌면 못 보는 로그를 계속 훑는 셈이 된다.
   */
  async sync(): Promise<void> {
    const { db } = this.ctx.handle;
    const enabled = db.select().from(alertRules).where(eq(alertRules.enabled, 1)).all();

    // 규칙 주인이 아직 그 환경을 볼 수 있는가. 아니면 규칙을 끄고 이유를 남긴다.
    const allowed: AlertRuleRow[] = [];
    for (const r of enabled) {
      if (this.stillAllowed(r)) allowed.push(r);
      else this.disable(r.id, 'access_revoked');
    }

    // 대상별로 묶는다. 상한을 넘으면 오래된 규칙의 대상부터 살린다 —
    // 조용히 아무거나 버리면 어느 규칙이 죽었는지 알 수 없다.
    const byTarget = new Map<string, AlertRuleRow[]>();
    for (const r of allowed) {
      const id = tailKeyOf(targetOf(r));
      const list = byTarget.get(id);
      if (list) list.push(r);
      else byTarget.set(id, [r]);
    }

    const max = this.ctx.cfg.ALERT_MAX_TARGETS;
    const keep = [...byTarget.keys()].slice(0, max);
    for (const id of [...byTarget.keys()].slice(max)) {
      for (const r of byTarget.get(id)!) this.disable(r.id, 'too_many_targets');
      byTarget.delete(id);
    }

    // 더 이상 필요 없는 구독을 놓는다.
    for (const [id, w] of this.watched) {
      if (!keep.includes(id)) {
        w.unsubscribe();
        this.watched.delete(id);
      }
    }

    // 새로 필요한 것을 잡고, 이미 있는 것은 규칙만 갈아끼운다.
    for (const id of keep) {
      const rows = byTarget.get(id)!;
      const compiled = this.compileAll(rows);
      const existing = this.watched.get(id);
      if (existing) {
        existing.rules = compiled;
        continue;
      }
      const key = targetOf(rows[0]!);
      try {
        const org = this.ctx.cfg.orgs.get(key.orgKey);
        if (!org) continue;
        const grant = this.grantFor(rows[0]!);
        if (!grant) continue;

        const slot: Watched = { key, unsubscribe: () => {}, rules: compiled };
        const handle = await this.ctx.tails.subscribe(key, org, grant.env.programId, (ev) =>
          this.onEvent(slot, ev),
        );
        slot.unsubscribe = handle.unsubscribe;
        this.watched.set(id, slot);
      } catch (err) {
        // 세션을 못 열었다. 다음 sync 에서 다시 시도한다 — 규칙은 살려둔다.
        console.error(`[alerts] ${id} 감시를 시작하지 못했다:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private compileAll(rows: AlertRuleRow[]): { row: AlertRuleRow; compiled: CompiledRule }[] {
    const out: { row: AlertRuleRow; compiled: CompiledRule }[] = [];
    for (const row of rows) {
      try {
        out.push({
          row,
          compiled: compileRule({
            pattern: row.pattern,
            isRegex: row.isRegex === 1,
            levels: parseLevels(row.levels),
          }),
        });
      } catch (err) {
        // 등록 때 검사했지만 DB 를 직접 고쳤을 수 있다. 조용히 무시하지 않는다.
        this.disable(row.id, err instanceof PatternError ? err.key : 'pattern_invalid');
      }
    }
    return out;
  }

  private grantFor(r: AlertRuleRow) {
    const su = this.sessionlessUser(r.userId);
    if (!su) return null;
    return checkEnvAccess(this.ctx, su, r.orgKey, r.environmentId);
  }

  /**
   * 규칙 평가에 쓸 사용자.
   *
   * 세션 쿠키 없이 권한만 봐야 하므로 users/user_orgs 에서 직접 만든다.
   * resolveSession 을 못 쓰는 것은 로그인 세션과 규칙의 수명이 다르기 때문이다 —
   * 브라우저를 닫아도 규칙은 계속 돌아야 한다.
   */
  private sessionlessUser(userId: string) {
    const { db } = this.ctx.handle;
    const rows = db.all(sql`
      SELECT u.id, u.email, u.is_active AS isActive, u.role,
             o.org_key AS orgKey, o.allow_prod AS allowProd
      FROM users u LEFT JOIN user_orgs o ON o.user_id = u.id
      WHERE u.id = ${userId}
    `) as { id: string; email: string; isActive: number; role: string; orgKey: string | null; allowProd: number | null }[];

    const first = rows[0];
    if (!first || first.isActive !== 1) return null;

    return {
      user: { id: first.id, email: first.email, role: first.role } as never,
      sessionId: '',
      createdAt: 0,
      expiresAt: 0,
      orgs: rows
        .filter((r) => r.orgKey !== null)
        .map((r) => ({ orgKey: r.orgKey!, allowProd: r.allowProd === 1 })),
    };
  }

  private stillAllowed(r: AlertRuleRow): boolean {
    return this.grantFor(r) !== null;
  }

  private disable(ruleId: string, reason: string): void {
    this.ctx.handle.db
      .update(alertRules)
      .set({ enabled: 0, disabledReason: reason })
      .where(eq(alertRules.id, ruleId))
      .run();
  }

  private onEvent(slot: Watched, ev: TailEvent): void {
    if (ev.type !== 'entries') return;
    for (const entry of ev.entries) {
      for (const { row, compiled } of slot.rules) {
        try {
          if (compiled.test(entry)) this.record(row, entry);
        } catch {
          // 규칙 하나가 터져도 나머지는 계속 본다.
        }
      }
    }
  }

  /**
   * 히트를 남긴다. 같은 사건이 쿨다운 안에 다시 오면 새 알림을 만들지 않고
   * 기존 것의 건수만 올린다 — 규칙 하나가 초당 수십 번 맞을 수 있다.
   */
  private record(rule: AlertRuleRow, entry: LogEntry): void {
    const { db } = this.ctx.handle;
    const signature = signatureOf(entry);
    const key = `${rule.id} ${signature}`;
    const now = Date.now();

    const last = this.lastFired.get(key) ?? this.lastFiredFromDb(rule.id, signature);
    if (last !== null && now - last < rule.cooldownSec * 1000) {
      // 조용히 세기만 한다. 화면에는 건수가 올라간 것으로 보인다.
      db.update(alertHits)
        .set({ count: sql`${alertHits.count} + 1`, lastTs: entry.ts, lastSeq: entry.seq })
        .where(and(eq(alertHits.ruleId, rule.id), eq(alertHits.signature, signature)))
        .run();
      return;
    }

    this.lastFired.set(key, now);
    const id = randomUUID();
    db.insert(alertHits)
      .values({
        id,
        ruleId: rule.id,
        signature,
        firstTs: entry.ts,
        lastTs: entry.ts,
        count: 1,
        firstSeq: entry.seq,
        lastSeq: entry.seq,
        level: entry.level,
        readAt: null,
        createdAt: now,
      })
      .run();

    this.emit({
      hitId: id,
      ruleId: rule.id,
      ruleName: rule.name,
      userId: rule.userId,
      orgKey: rule.orgKey,
      environmentId: rule.environmentId,
      service: rule.service,
      logName: rule.logName,
      level: entry.level,
      count: 1,
      lastTs: entry.ts,
      lastSeq: entry.seq,
    });
  }

  /** 재시작 직후에는 메모리가 비어 있다. DB 를 봐야 알림 폭탄을 안 낸다. */
  private lastFiredFromDb(ruleId: string, signature: string): number | null {
    const row = this.ctx.handle.db
      .select({ createdAt: alertHits.createdAt })
      .from(alertHits)
      .where(and(eq(alertHits.ruleId, ruleId), eq(alertHits.signature, signature)))
      .orderBy(desc(alertHits.createdAt))
      .get();
    return row?.createdAt ?? null;
  }

  private emit(e: HitEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // 구독자 하나가 터져도 나머지는 계속 받는다
      }
    }
  }
}

/** 오래된 히트를 지운다. 감사 기록과 같은 이유로 무한히 쌓게 두지 않는다. */
export function purgeOldHits(db: AppContext['handle']['db'], days: number): number {
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 24 * 3600_000;
  return db.delete(alertHits).where(lt(alertHits.createdAt, cutoff)).run().changes;
}

/** 안 읽은 건수. 벨 배지가 쓰는 값이다. */
export function unreadCount(db: AppContext['handle']['db'], userId: string): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(alertHits)
    .innerJoin(alertRules, eq(alertRules.id, alertHits.ruleId))
    .where(and(eq(alertRules.userId, userId), isNull(alertHits.readAt)))
    .get();
  return row?.n ?? 0;
}
