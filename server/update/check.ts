export interface UpdateInfo {
  /** 'v1.2.0' */
  tag: string;
  /** '1.2.0' */
  version: string;
  /** 릴리스 노트 페이지 */
  url: string;
  publishedAt: string | null;
}

export interface UpdateState {
  current: string;
  /** 마지막으로 확인한 최신 릴리스. 아직 못 봤으면 null */
  latest: UpdateInfo | null;
  checkedAt: number | null;
  /** 마지막 확인이 실패한 이유. 성공했으면 null */
  error: string | null;
}

/** 'v1.2.3-beta' → [1, 2, 3]. 앞의 v 와 프리릴리스 꼬리는 무시한다. */
function parts(v: string): number[] {
  const core = v.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
  return core.split('.').map((s) => Number.parseInt(s, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

export interface UpdateCheckerOptions {
  /** 'owner/repo' */
  repo: string;
  current: string;
  fetchImpl?: typeof fetch;
  /** 확인 주기. 비인증 한도가 시간당 60회라 하루 한 번이면 넉넉하다 */
  intervalMs?: number;
  /** 부팅 직후는 Cloud Manager 쪽이 바쁘다. 조금 미룬다 */
  initialDelayMs?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * GitHub 에 새 릴리스가 있는지 하루 한 번 묻는다.
 *
 * 서버가 한 번만 묻는다 — 뷰어마다 GitHub 를 부르면 호출이 뷰어 수만큼 나가고,
 * Tailscale 안의 모니터는 인터넷이 없을 수 있다. 결과는 /api/version 으로 내주고
 * 관리자 메뉴에만 보인다. 일반 뷰어는 서버를 올릴 수 없으니 알려봐야 할 게 없다.
 *
 * 실패는 조용하다. 인터넷이 막힌 서버, 저장소가 아직 비공개인 경우(404) 전부
 * 정상 상황이고, 로그 한 줄 외에는 아무 일도 일어나지 않는다.
 */
export class UpdateChecker {
  private latest: UpdateInfo | null = null;
  private checkedAt: number | null = null;
  private error: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly initialDelayMs: number;
  private readonly timeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: UpdateCheckerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.intervalMs = opts.intervalMs ?? 24 * 3600_000;
    this.initialDelayMs = opts.initialDelayMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.log = opts.log ?? (() => {});
  }

  state(): UpdateState {
    return { current: this.opts.current, latest: this.latest, checkedAt: this.checkedAt, error: this.error };
  }

  /** 지금 실행 중인 것보다 새 릴리스가 있으면 그것, 아니면 null */
  available(): UpdateInfo | null {
    return this.latest && isNewer(this.latest.version, this.opts.current) ? this.latest : null;
  }

  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => {
      void this.checkOnce();
      this.timer = setInterval(() => void this.checkOnce(), this.intervalMs);
      this.timer.unref();
    }, this.initialDelayMs);
    first.unref();
    this.timer = first;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkOnce(): Promise<UpdateState> {
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      await this.probe(ctl.signal);
    } catch (err) {
      this.error = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'unreachable';
    } finally {
      clearTimeout(kill);
      this.checkedAt = Date.now();
    }
    // finally 뒤에 돌려줘야 checkedAt 이 실린다. try 안에서 return 하면 스냅샷이 먼저 찍힌다.
    return this.state();
  }

  private async probe(signal: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(`https://api.github.com/repos/${this.opts.repo}/releases/latest`, {
      signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `aem-cloud-log-viewer/${this.opts.current}`,
      },
    });
    if (!res.ok) {
      this.error = `http_${res.status}`;
      return;
    }
    const rel = (await res.json()) as GithubRelease;
    if (!rel.tag_name || rel.draft || rel.prerelease) {
      this.error = 'no_release';
      return;
    }
    this.latest = {
      tag: rel.tag_name,
      version: rel.tag_name.replace(/^v/i, ''),
      url: rel.html_url ?? `https://github.com/${this.opts.repo}/releases/tag/${rel.tag_name}`,
      publishedAt: rel.published_at ?? null,
    };
    this.error = null;
    const up = this.available();
    if (up) this.log(`[update] new release ${up.tag} (running ${this.opts.current}) — ${up.url}`);
  }
}
