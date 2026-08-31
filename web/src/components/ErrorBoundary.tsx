import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Center, Code, Stack, Text } from '@mantine/core';
import { tStatic } from '../i18n';

/**
 * 모니터에 걸어두는 화면이라 스스로 일어나야 한다.
 *
 * 렌더 중 예외가 하나 나면 React 는 트리를 통째로 언마운트한다. 사람이 앞에 있으면
 * 새로고침을 누르지만, 벽에 걸린 화면은 그대로 흰 채로 밤을 샌다.
 * 그래서 여기서 붙잡고, 무엇이 났는지 보여주고, 잠깐 뒤에 알아서 다시 뜬다.
 *
 * 되풀이해 터지는 경우를 위해 기다리는 시간을 두 배씩 늘린다 —
 * 1초마다 새로고침하는 화면은 흰 화면보다 나을 게 없다.
 */

const FIRST_DELAY_SEC = 5;
const MAX_DELAY_SEC = 300;
/** 새로고침이 페이지를 갈아치우므로 횟수는 세션 저장소에 남긴다. */
const STORAGE_KEY = 'aclv.crashCount';

function crashCount(): number {
  try {
    return Number(sessionStorage.getItem(STORAGE_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function bumpCrashCount(): number {
  const n = crashCount() + 1;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // 사생활 보호 모드. 이번 판에서는 매번 첫 지연으로 다시 시작한다.
  }
  return n;
}

/** 사람이 멀쩡히 쓰고 있으면 지금까지의 실패는 잊는다. */
export function noteHealthy(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 무시한다
  }
}

interface State {
  error: Error | null;
  secondsLeft: number;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null, secondsLeft: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 콘솔에는 남긴다. 무인 화면이라도 나중에 누군가는 열어본다.
    console.error('[크래시]', error, info.componentStack);

    const n = bumpCrashCount();
    const delay = Math.min(MAX_DELAY_SEC, FIRST_DELAY_SEC * 2 ** (n - 1));
    this.setState({ secondsLeft: delay });

    this.timer = setInterval(() => {
      this.setState((s) => {
        if (s.secondsLeft <= 1) {
          window.location.reload();
          return { secondsLeft: 0 };
        }
        return { secondsLeft: s.secondsLeft - 1 };
      });
    }, 1000);
  }

  override componentWillUnmount(): void {
    if (this.timer) clearInterval(this.timer);
  }

  override render(): ReactNode {
    const { error, secondsLeft } = this.state;
    if (!error) return this.props.children;

    return (
      <Center h="100%" p="xl">
        <Stack gap="xs" align="center" maw={560}>
          <Text fw={600}>{tStatic('crash.title')}</Text>
          <Text size="sm" c="dimmed" ta="center">
            {tStatic('crash.detail')}
          </Text>
          <Code block style={{ maxWidth: '100%', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
            {error.message || String(error)}
          </Code>
          <Text size="xs" c="dimmed">
            {tStatic('crash.reloadIn', { n: secondsLeft })}
          </Text>
          <Button size="compact-sm" variant="default" onClick={() => window.location.reload()}>
            {tStatic('crash.reloadNow')}
          </Button>
        </Stack>
      </Center>
    );
  }
}
