import { useState, type FormEvent } from 'react';
import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { api, ApiRequestError } from '../api/client';
import { useSession } from '../api/session';
import { useT } from '../i18n';

/** must_change_password 가 걸린 계정은 이 화면 밖으로 나갈 수 없다. */
export function ChangePasswordPage({ forced }: { forced: boolean }) {
  const { me, setMe } = useSession();
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setError(t('password.mismatch'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setMe(await api.changePassword(current, next));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('password.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center h="100%">
      <Paper withBorder p="xl" w={380}>
        <form onSubmit={submit}>
          <Stack gap="md">
            <div>
              <Title order={4}>{t('password.title')}</Title>
              {forced && (
                <Text size="xs" c="dimmed">
                  {t('password.forced')}
                </Text>
              )}
            </div>

            {error && (
              <Alert color="red" variant="light" p="xs">
                <Text size="sm">{error}</Text>
              </Alert>
            )}

            <PasswordInput
              label={t('password.current')}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.currentTarget.value)}
              required
              autoFocus
            />
            <PasswordInput
              label={t('password.new')}
              description={me ? t('password.minLength', { n: me.minPasswordLength }) : undefined}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label={t('password.confirm')}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.currentTarget.value)}
              required
            />
            <Button type="submit" loading={busy} fullWidth>
              {t('password.title')}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
