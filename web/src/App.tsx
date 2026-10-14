import { useEffect } from 'react';
import { AppShell, Box, Button, Center, Group, Loader, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './api/session';
import { LangProvider, useT } from './i18n';
import { ErrorBoundary, noteHealthy } from './components/ErrorBoundary';
import { purgeServiceWorkerCaches } from './pwa';
import { LangToggle } from './components/LangToggle';
import { api, ApiRequestError } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { EnvironmentsPage } from './pages/EnvironmentsPage';
import { TailPage } from './pages/TailPage';
import { SearchPage } from './pages/SearchPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AdminAuditPage } from './pages/AdminAuditPage';
import { AlertRulesPage } from './pages/AlertRulesPage';
import { AlertBell } from './components/AlertBell';
import { InstallBanner, useInstallBanner, INSTALL_BANNER_HEIGHT } from './components/InstallBanner';

function Shell() {
  const { me, loading, setMe } = useSession();
  const t = useT();
  const install = useInstallBanner();

  // 1분을 멀쩡히 버텼으면 그 전의 실패는 잊는다. 안 그러면 어제 한 번 터진 것 때문에
  // 오늘의 첫 자동 새로고침이 5분 뒤로 밀린다.
  useEffect(() => {
    const t = setTimeout(noteHealthy, 60_000);
    return () => clearTimeout(t);
  }, []);

  if (loading) {
    return (
      <Center h="100%">
        <Loader size="sm" />
      </Center>
    );
  }

  if (!me) return <LoginPage />;

  // 비밀번호 변경 전에는 다른 화면으로 갈 수 없다. 서버도 403 으로 같이 막는다.
  if (me.mustChangePassword) return <ChangePasswordPage forced />;

  /*
    로그아웃은 '이 기기에서 나간다' 는 뜻이다. 그래서 서버 호출은 최선의 노력이고,
    화면을 비우는 것은 무조건이다.

    예전에는 `await api.logout()` 이 맨 앞에 혼자 있었다. 그 호출이 던지면 아래가
    통째로 건너뛰어지는데, onClick 이 `void logout()` 이라 그 예외를 받는 곳이 없다.
    사람 눈에는 **눌렀는데 아무 일도 안 일어난다** — 메뉴만 닫히고 그대로다.

    실제로 그 호출은 **늘** 던지고 있었다. fetch 래퍼가 본문도 없이
    `Content-Type: application/json` 을 붙이는 바람에 Fastify 본문 파서가 400 으로
    끊었다 (client.ts 참고). 즉 로그아웃은 한 번도 동작한 적이 없다.

    그건 고쳤지만 이 구조는 그대로 두면 안 된다. 세션이 이미 만료됐거나 관리자가
    끊었으면 인증 훅이 로그아웃 요청까지 401 로 막고, 서버를 재시작한 직후면 닿지도
    못한다. 둘 다 **화면은 아직 로그인된 것처럼 보이는** 순간이라 — 세션 확인이
    10분에 한 번이라 그렇다 — 사람이 로그아웃을 누르는 상황과 정확히 겹친다.
  */
  const logout = async () => {
    try {
      await api.logout();
    } catch (err) {
      // 401 은 이미 서버에 세션이 없다는 뜻이니 로그아웃의 목적은 이미 달성됐다.
      // 그 밖의 실패는 세션이 서버에 남아 있을 수 있어서 말해줘야 한다.
      if (!(err instanceof ApiRequestError && err.status === 401)) {
        notifications.show({ color: 'yellow', title: t('nav.logout'), message: t('err.logoutOffline') });
      }
    } finally {
      // 껍데기 캐시에 비밀이 있지는 않다. 다만 '나가면 아무것도 안 남는다' 는
      // 이 도구의 약속이라, 지킬 수 있는 곳에서는 기계적으로 지킨다.
      purgeServiceWorkerCaches();
      setMe(null);
    }
  };

  // 배너가 뜨면 머리줄이 그만큼 두꺼워진다. 본문 여백이 같은 값을 써야 어긋나지 않는다.
  const headerHeight = 44 + (install === 'hidden' ? 0 : INSTALL_BANNER_HEIGHT);

  return (
    <AppShell header={{ height: headerHeight }} padding={0} style={{ height: '100%' }}>
      <AppShell.Header>
        <InstallBanner state={install} />
        <Group h={44} px="sm" justify="space-between">
          <Group gap="sm">
            <Text size="sm" fw={600} component="a" href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              AEM Cloud Log Viewer
            </Text>
          </Group>
          <Group gap={4}>
            <AlertBell />
            <Menu position="bottom-end">
            <Menu.Target>
              <Button variant="subtle" size="compact-sm" color="gray">
                {me.displayName}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{me.email}</Menu.Label>
              {me.role === 'admin' && (
                <>
                  <Menu.Divider />
                  <Menu.Item component="a" href="/admin/users">
                    {t('nav.users')}
                  </Menu.Item>
                  <Menu.Item component="a" href="/admin/audit">
                    {t('nav.audit')}
                  </Menu.Item>
                  <Menu.Divider />
                </>
              )}
              <Menu.Item component="a" href="/password">
                {t('nav.changePassword')}
              </Menu.Item>
              <Menu.Item onClick={() => void logout()}>{t('nav.logout')}</Menu.Item>
              <Menu.Divider />
              <Menu.Label>{t('nav.language')}</Menu.Label>
              <Box px="xs" pb="xs">
                <LangToggle />
              </Box>
            </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Main style={{ height: '100%', paddingTop: headerHeight, boxSizing: 'border-box' }}>
        {/*
          tail·조회는 스스로 높이를 나눠 쓰므로 여기서 자르면 안 되고, 목록 화면은
          내용이 길면 넘친다. auto 면 둘 다 맞는다 — 100% 인 화면은 넘칠 일이 없어
          막대가 안 뜨고, 넘치는 화면만 스크롤된다.
        */}
        <Box style={{ height: '100%', overflow: 'auto' }}>
          {/*
            창 하나가 터져도 머리줄은 남아야 사람이 다른 데로 갈 수 있다.
            바깥 경계는 이것마저 실패했을 때를 위한 것이다.
          */}
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<EnvironmentsPage />} />
              <Route path="/tail" element={<TailPage />} />
              <Route path="/search" element={<SearchPage />} />
              {me.role === 'admin' && <Route path="/admin/users" element={<AdminUsersPage />} />}
              {me.role === 'admin' && <Route path="/admin/audit" element={<AdminAuditPage />} />}
              <Route path="/alerts" element={<AlertRulesPage />} />
              <Route path="/password" element={<ChangePasswordPage forced={false} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </ErrorBoundary>
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}

export function App() {
  return (
    <LangProvider>
      <ErrorBoundary>
        <SessionProvider>
          <Shell />
        </SessionProvider>
      </ErrorBoundary>
    </LangProvider>
  );
}
