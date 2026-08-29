import type { AppConfig, OrgConfig } from '../config/env.js';
import { Masker } from '../parse/mask.js';
import { CloudManagerClient } from '../adobe/cloudmanager.js';
import { CloudManagerTailTransport, type TailTransport } from './transport.js';
import { TailSession, tailKeyOf, type TailKey, type TailListener } from './session.js';

interface Slot {
  session: TailSession;
  /** 구독자가 0이 된 뒤 정리 예약 */
  idleTimer: NodeJS.Timeout | null;
}

/**
 * TailSession 생명주기 관리.
 *
 * 같은 (org, env, service, logName) 을 두 명이 봐도 폴링 루프는 하나다.
 * 구독자를 ref-count 하고, 0이 된 채로 idleTimeoutMs 가 지나면 루프를 멈추고 버퍼를 비운다.
 */
export class TailRegistry {
  private readonly slots = new Map<string, Slot>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly cm: CloudManagerClient,
    /**
     * transport 를 만드는 방법. 테스트에서 가짜를 물리기 위한 이음매다.
     * ref-count 와 유휴 정리는 조용히 새는 곳이라 실제로 검증해야 한다 —
     * 세션이 안 죽으면 폴링 루프가 영원히 돈다.
     */
    private readonly makeTransport: (key: TailKey, org: OrgConfig, programId: string) => TailTransport = (
      key,
      org,
      programId,
    ) => new CloudManagerTailTransport(cm, org, programId, key.environmentId, key.service, key.logName),
  ) {}

  /** 진행 중인 세션 수 (관리·디버깅용) */
  get activeCount(): number {
    return this.slots.size;
  }

  peek(key: TailKey): TailSession | undefined {
    return this.slots.get(tailKeyOf(key))?.session;
  }

  /**
   * 세션을 얻고 구독한다. 없으면 만들어 start() 한다.
   * 반환된 함수를 부르면 구독이 해지되고, 마지막 구독자였다면 유휴 타이머가 걸린다.
   */
  async subscribe(
    key: TailKey,
    org: OrgConfig,
    programId: string,
    listener: TailListener,
  ): Promise<{ session: TailSession; unsubscribe: () => void }> {
    const id = tailKeyOf(key);
    let slot = this.slots.get(id);

    if (!slot) {
      const transport = this.makeTransport(key, org, programId);
      const session = new TailSession({
        key,
        transport,
        masker: new Masker(this.cfg.MASKING_ENABLED),
        pollIntervalMs: this.cfg.TAIL_POLL_INTERVAL_MS,
        initialBytes: this.cfg.TAIL_INITIAL_BYTES,
        maxLines: this.cfg.TAIL_BUFFER_MAX_LINES,
        maxBytes: this.cfg.TAIL_BUFFER_MAX_BYTES,
      });
      slot = { session, idleTimer: null };
      this.slots.set(id, slot);

      try {
        await session.start();
      } catch (err) {
        // 시작에 실패한 세션을 레지스트리에 남겨두면 다음 요청이 죽은 세션을 잡는다.
        this.slots.delete(id);
        throw err;
      }
    }

    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }

    const off = slot.session.subscribe(listener);
    const current = slot;

    return {
      session: current.session,
      unsubscribe: () => {
        off();
        if (current.session.subscriberCount > 0) return;
        if (current.idleTimer) clearTimeout(current.idleTimer);
        current.idleTimer = setTimeout(() => {
          // 유휴 타이머가 도는 사이에 누가 다시 붙었을 수 있다.
          if (current.session.subscriberCount > 0) return;
          current.session.stop();
          this.slots.delete(id);
        }, this.cfg.TAIL_IDLE_TIMEOUT_MS);
        current.idleTimer.unref();
      },
    };
  }

  /** 서버 종료 시. 모든 폴링 루프를 멈추고 버퍼를 비운다. */
  stopAll(): void {
    for (const slot of this.slots.values()) {
      if (slot.idleTimer) clearTimeout(slot.idleTimer);
      slot.session.stop();
    }
    this.slots.clear();
  }
}
