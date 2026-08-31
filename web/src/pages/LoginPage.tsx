import { useState, type FormEvent } from 'react';
import { Alert, Button, Center, Group, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { api, ApiRequestError } from '../api/client';
import { useSession } from '../api/session';
import { useT } from '../i18n';
import { LangToggle } from '../components/LangToggle';

export function LoginPage() {
  const { setMe, expired } = useSession();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setMe(await api.login(email, password));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('login.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center h="100%">
      <Paper withBorder p="xl" w={380}>
        <form onSubmit={submit}>
          <Stack gap="md">
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Title order={4}>AEM Cloud Log Viewer</Title>
                <Text size="xs" c="dimmed">
                  {t('login.subtitle')}
                </Text>
              </div>
              {/* 로그인 전에도 말을 바꿀 수 있어야 한다 */}
              <LangToggle />
            </Group>

            {/*
              보고 있다가 끊긴 것과 처음 들어온 것은 다른 상황이다.
              모니터에 걸어둔 화면이 로그인 창으로 돌아가 있으면, 왜 그런지는 말해줘야 한다.
            */}
            {expired && !error && (
              <Alert color="yellow" variant="light" p="xs">
                <Text size="sm" fw={500}>
                  {t('session.expiredTitle')}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('session.expiredDetail')}
                </Text>
              </Alert>
            )}

            {error && (
              <Alert color="red" variant="light" p="xs">
                <Text size="sm">{error}</Text>
              </Alert>
            )}

            <TextInput
              label={t('common.email')}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
              autoFocus
            />
            <PasswordInput
              label={t('common.password')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <Button type="submit" loading={busy} fullWidth>
              {t('login.submit')}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
