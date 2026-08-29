import { useState, type FormEvent } from 'react';
import { Alert, Button, Center, Group, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { api, ApiRequestError } from '../api/client';
import { useSession } from '../api/session';
import { useT } from '../i18n';
import { LangToggle } from '../components/LangToggle';

export function LoginPage() {
  const { setMe } = useSession();
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
