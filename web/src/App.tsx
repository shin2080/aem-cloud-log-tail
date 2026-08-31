import { useEffect } from 'react';
import { AppShell, Box, Button, Center, Group, Loader, Menu, Text } from '@mantine/core';
import { Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './api/session';
import { LangProvider, useT } from './i18n';
import { ErrorBoundary, noteHealthy } from './components/ErrorBoundary';
import { purgeServiceWorkerCaches } from './pwa';
import { LangToggle } from './components/LangToggle';
import { api } from './api/client';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { EnvironmentsPage } from './pages/EnvironmentsPage';
import { TailPage } from './pages/TailPage';
import { SearchPage } from './pages/SearchPage';
import { AdminUsersPage } from './pages/AdminUsersPage';
import { AdminAuditPage } from './pages/AdminAuditPage';

function Shell() {
  const { me, loading, setMe } = useSession();
  const t = useT();

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

  const logout = async () => {
    await api.logout();
    // 껍데기 캐시에 비밀이 있지는 않다. 다만 '나가면 아무것도 안 남는다' 는
    // 이 도구의 약속이라, 지킬 수 있는 곳에서는 기계적으로 지킨다.
    purgeServiceWorkerCaches();
    setMe(null);
  };

  return (
    <AppShell header={{ height: 44 }} padding={0} style={{ height: '100%' }}>
      <AppShell.Header>
        <Group h="100%" px="sm" justify="space-between">
          <Group gap="sm">
            <Text size="sm" fw={600} component="a" href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
              AEM Cloud Log Viewer
            </Text>
          </Group>
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
      </AppShell.Header>

      <AppShell.Main style={{ height: '100%', paddingTop: 44, boxSizing: 'border-box' }}>
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
