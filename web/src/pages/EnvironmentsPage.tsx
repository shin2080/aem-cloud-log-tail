import { useEffect, useState } from 'react';
import { Alert, Badge, Box, Button, Group, Loader, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useNavigate } from 'react-router-dom';
import { compareLogNames, type AvailableService, type EnvironmentSummary } from '@shared/types';
import { api, ApiRequestError } from '../api/client';
import { useSession } from '../api/session';
import { ENV_COLOR } from '../theme';
import { useT } from '../i18n';

const qs = (e: EnvironmentSummary, service: string, name: string): string =>
  new URLSearchParams({ org: e.orgKey, env: e.environmentId, service, name }).toString();

export function EnvironmentsPage() {
  const { me } = useSession();
  const t = useT();
  const navigate = useNavigate();
  const [orgKey, setOrgKey] = useState<string | null>(me?.orgs[0]?.key ?? null);
  const [envs, setEnvs] = useState<EnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notGranted, setNotGranted] = useState<{ key: string; label: string }[]>([]);
  const [stale, setStale] = useState<string[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  // .env 에 있는데 권한이 없는 조직을 알려줘야 '왜 안 보이지' 가 풀린다.
  useEffect(() => {
    void api
      .orgs()
      .then((r) => {
        setNotGranted(r.notGranted);
        setStale(r.stale);
        setIsAdmin(r.isAdmin);
      })
      .catch(() => undefined);
  }, []);

  const load = async (key: string, refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setEnvs((await api.environments(key, refresh)).environments);
    } catch (err) {
      setEnvs([]);
      setError(err instanceof ApiRequestError ? err.message : t('env.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (orgKey) void load(orgKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgKey]);

  if (!me) return null;

  if (me.orgs.length === 0) {
    return (
      <Box p="md">
        <Alert color="yellow" variant="light">
          <Text size="sm">{t('env.noOrgs')}</Text>
        </Alert>
      </Box>
    );
  }

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between" align="center">
        <Group gap={4}>
          {me.orgs.map((o) => (
            <Button
              key={o.key}
              size="compact-sm"
              variant={o.key === orgKey ? 'filled' : 'subtle'}
              color="gray"
              onClick={() => setOrgKey(o.key)}
            >
              {o.label}
            </Button>
          ))}
        </Group>
        <Button
          size="compact-sm"
          variant="default"
          loading={loading}
          onClick={() => orgKey && void load(orgKey, true)}
        >
          {t('env.refresh')}
        </Button>
      </Group>

      {notGranted.length > 0 && (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="sm">{t('env.forbidden', { orgs: notGranted.map((o) => o.label).join(', ') })}</Text>
          <Text size="xs" c="dimmed" mt={2}>
            {t('env.forbiddenHelp')}{' '}
            {isAdmin ? t('env.forbiddenAdmin') : t('env.forbiddenMember')}
          </Text>
          {isAdmin && (
            <Button size="compact-xs" variant="default" mt={6} component="a" href="/admin/users">
              {t('env.goToUsers')}
            </Button>
          )}
        </Alert>
      )}

      {stale.length > 0 && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="sm">{t('env.stale', { orgs: stale.join(', ') })}</Text>
          <Text size="xs" c="dimmed" mt={2}>
            {t('env.staleHelp')}
          </Text>
        </Alert>
      )}

      {error && (
        <Alert color="red" variant="light" p="xs">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      {loading && envs.length === 0 ? (
        <Group gap="xs" p="md">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            {t('env.loading')}
          </Text>
        </Group>
      ) : envs.length === 0 && !error ? (
        <Alert variant="light" color="gray">
          <Text size="sm">{t('env.empty')}</Text>
        </Alert>
      ) : (
        <Table highlightOnHover verticalSpacing={6}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('env.colEnv')}</Table.Th>
              <Table.Th>{t('env.colType')}</Table.Th>
              <Table.Th>{t('env.colProgram')}</Table.Th>
              <Table.Th>{t('env.colServices')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {envs.map((e) => (
              <EnvRow
                key={e.environmentId}
                env={e}
                onOpen={(service, name) => navigate(`/tail?${qs(e, service, name)}`)}
                onSearch={(service, name) => navigate(`/search?${qs(e, service, name)}`)}
              />
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function EnvRow({
  env,
  onOpen,
  onSearch,
}: {
  env: EnvironmentSummary;
  onOpen: (service: string, name: string) => void;
  onSearch: (service: string, name: string) => void;
}) {
  const t = useT();
  const [services, setServices] = useState<AvailableService[]>(env.availableServices);
  const [supported, setSupported] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const loadServices = async () => {
    setLoading(true);
    try {
      const r = await api.logOptions(env.orgKey, env.environmentId);
      setServices(r.services);
      setSupported(r.supported);
    } finally {
      setLoading(false);
    }
  };

  // 파서가 있는 로그만 열 수 있다. 서버가 어느 것인지 알려준다.
  const canOpen = (name: string): boolean => supported.length === 0 || supported.includes(name);
  const tailable = services
    .map((s) => ({ service: s.service, logNames: [...s.logNames].filter(canOpen).sort(compareLogNames) }))
    .filter((s) => s.logNames.length > 0);

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" ff="monospace">
          {env.environmentName}
        </Text>
        <Text size="xs" c="dimmed" ff="monospace">
          {env.environmentId}
        </Text>
      </Table.Td>
      <Table.Td>
        <Badge size="sm" variant="light" color={ENV_COLOR[env.environmentType] ?? 'gray'}>
          {env.environmentType}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed">
          {env.programName}
        </Text>
      </Table.Td>
      <Table.Td>
        {services.length === 0 ? (
          <Button size="compact-xs" variant="default" loading={loading} onClick={() => void loadServices()}>
            {t('env.checkServices')}
          </Button>
        ) : tailable.length === 0 ? (
          <Text size="xs" c="dimmed">
            {t('env.noOpenable')}
          </Text>
        ) : (
          <Stack gap={6}>
            {tailable.map((s) => (
              <Group key={s.service} gap={6} wrap="wrap" align="center">
                <Text size="xs" c="dimmed" ff="monospace" style={{ minWidth: 130 }}>
                  {s.service}
                </Text>
                {s.logNames.map((name) => (
                  <Button.Group key={name}>
                    <Tooltip label={t('env.tailTip', { service: s.service, name })} withArrow openDelay={500}>
                      <Button
                        size="compact-xs"
                        variant="light"
                        color="gray"
                        onClick={() => onOpen(s.service, name)}
                      >
                        {name}
                      </Button>
                    </Tooltip>
                    <Tooltip label={t('env.searchTip')} withArrow openDelay={500}>
                      <Button
                        size="compact-xs"
                        variant="default"
                        aria-label={t('env.searchAria', { service: s.service, name })}
                        onClick={() => onSearch(s.service, name)}
                      >
                        <span aria-hidden="true">⌕</span>
                      </Button>
                    </Tooltip>
                  </Button.Group>
                ))}
              </Group>
            ))}
          </Stack>
        )}
      </Table.Td>
    </Table.Tr>
  );
}
