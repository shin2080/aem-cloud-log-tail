import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  CopyButton,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { api, ApiRequestError } from '../api/client';
import { useSession } from '../api/session';
import { useT } from '../i18n';

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  orgs: { key: string; allowProd: boolean }[];
  activeSessions: number;
}

interface OrgOption {
  key: string;
  label: string;
}

const fmt = (ms: number | null): string =>
  ms === null ? '—' : new Date(ms + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);

export function AdminUsersPage() {
  const { me } = useSession();
  const t = useT();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);
  /** 임시 비밀번호는 서버가 한 번만 준다. 닫으면 다시 볼 수 없다. */
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, o] = await Promise.all([api.adminUsers(), api.adminOrgs()]);
      setUsers(u.users);
      setOrgs(o.orgs);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('users.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('users.actionFailed'));
    }
  };

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between">
        <Title order={5}>{t('users.title')}</Title>
        <Button size="compact-sm" onClick={() => setCreating(true)}>
          {t('users.issue')}
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" p="xs">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      <Table highlightOnHover verticalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('users.colAccount')}</Table.Th>
            <Table.Th>{t('users.colRole')}</Table.Th>
            <Table.Th>{t('users.colOrgs')}</Table.Th>
            <Table.Th>{t('users.colLastLogin')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {users.map((u) => (
            <Table.Tr key={u.id} opacity={u.isActive ? 1 : 0.45}>
              <Table.Td>
                <Group gap={6}>
                  <Text size="sm">{u.displayName}</Text>
                  {u.id === me?.id && (
                    <Badge size="xs" variant="light" color="gray">
                      {t('users.me')}
                    </Badge>
                  )}
                  {!u.isActive && (
                    <Badge size="xs" variant="light" color="gray">
                      {t('users.inactive')}
                    </Badge>
                  )}
                  {u.mustChangePassword && (
                    <Badge size="xs" variant="light" color="yellow">
                      {t('users.mustChange')}
                    </Badge>
                  )}
                </Group>
                <Text size="xs" c="dimmed" ff="monospace">
                  {u.email}
                </Text>
              </Table.Td>
              <Table.Td>
                <Badge size="sm" variant={u.role === 'admin' ? 'filled' : 'light'} color="gray">
                  {u.role}
                </Badge>
              </Table.Td>
              <Table.Td>
                {u.orgs.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    {t('common.none')}
                  </Text>
                ) : (
                  <Group gap={4}>
                    {u.orgs.map((o) => (
                      <Badge key={o.key} size="xs" variant="light" color={o.allowProd ? 'red' : 'gray'}>
                        {o.key}
                        {o.allowProd ? ' +prod' : ''}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed">
                  {fmt(u.lastLoginAt)}
                </Text>
                {u.activeSessions > 0 && (
                  <Group gap={4}>
                    <Text size="xs" c="dimmed">
                      {t('users.sessions', { n: u.activeSessions })}
                    </Text>
                    <Tooltip label={t('users.revokeTip')} withArrow>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        onClick={() => void act(() => api.adminRevokeSessions(u.id))}
                      >
                        {t('users.revoke')}
                      </Button>
                    </Tooltip>
                  </Group>
                )}
              </Table.Td>
              <Table.Td>
                <Group gap={4} justify="flex-end" wrap="nowrap">
                  <Button size="compact-xs" variant="default" onClick={() => setEditing(u)}>
                    {t('users.edit')}
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() =>
                      void act(async () => {
                        const { tempPassword } = await api.adminResetPassword(u.id);
                        setIssued({ email: u.email, password: tempPassword });
                      })
                    }
                  >
                    {t('users.resetPassword')}
                  </Button>
                  <Tooltip label={u.id === me?.id ? t('users.deleteSelf') : t('users.delete')} withArrow>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="red"
                      aria-label={t('users.deleteAria', { email: u.email })}
                      disabled={u.id === me?.id}
                      onClick={() => {
                        if (!confirm(t('users.deleteConfirm', { email: u.email }))) return;
                        void act(() => api.adminDeleteUser(u.id));
                      }}
                    >
                      ✕
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      {!loading && users.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('users.empty')}
        </Text>
      )}

      <UserFormModal
        opened={creating || editing !== null}
        user={editing}
        orgs={orgs}
        isSelf={editing?.id === me?.id}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onCreate={(input) =>
          act(async () => {
            const { user, tempPassword } = await api.adminCreateUser(input);
            setIssued({ email: user.email, password: tempPassword });
            setCreating(false);
          })
        }
        onUpdate={(id, patch) =>
          act(async () => {
            await api.adminUpdateUser(id, patch);
            setEditing(null);
          })
        }
      />

      <Modal opened={issued !== null} onClose={() => setIssued(null)} title={t('users.tempTitle')} size="md">
        <Stack gap="sm">
          <Alert color="yellow" variant="light" p="xs">
            <Text size="sm">{t('users.tempNote')}</Text>
          </Alert>
          <Text size="sm" c="dimmed">
            {issued?.email}
          </Text>
          <Group gap="xs">
            <Text ff="monospace" size="lg" style={{ userSelect: 'all' }}>
              {issued?.password}
            </Text>
            <CopyButton value={issued?.password ?? ''}>
              {({ copied, copy }) => (
                <Button size="compact-xs" variant="default" onClick={copy}>
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Text size="xs" c="dimmed">
            {t('users.tempForce')}
          </Text>
          <Group justify="flex-end">
            <Button onClick={() => setIssued(null)}>{t('users.tempOk')}</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

function UserFormModal({
  opened,
  user,
  orgs,
  isSelf,
  onClose,
  onCreate,
  onUpdate,
}: {
  opened: boolean;
  user: AdminUser | null;
  orgs: OrgOption[];
  isSelf: boolean | undefined;
  onClose: () => void;
  onCreate: (input: { email: string; displayName: string; role: 'admin' | 'member'; orgs: { key: string; allowProd: boolean }[] }) => void;
  onUpdate: (id: string, patch: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [isActive, setIsActive] = useState(true);
  const [grants, setGrants] = useState<Record<string, { on: boolean; prod: boolean }>>({});

  useEffect(() => {
    if (!opened) return;
    setEmail(user?.email ?? '');
    setDisplayName(user?.displayName ?? '');
    setRole(user?.role ?? 'member');
    setIsActive(user?.isActive ?? true);
    const g: Record<string, { on: boolean; prod: boolean }> = {};
    for (const o of orgs) {
      const has = user?.orgs.find((x) => x.key === o.key);
      g[o.key] = { on: Boolean(has), prod: has?.allowProd ?? false };
    }
    setGrants(g);
  }, [opened, user, orgs]);

  const selectedOrgs = Object.entries(grants)
    .filter(([, v]) => v.on)
    .map(([key, v]) => ({ key, allowProd: v.prod }));

  const submit = () => {
    if (user) onUpdate(user.id, { displayName, role, isActive, orgs: selectedOrgs });
    else onCreate({ email, displayName, role, orgs: selectedOrgs });
  };

  return (
    <Modal opened={opened} onClose={onClose} title={user ? t('users.editTitle') : t('users.issue')} size="md">
      <Stack gap="sm">
        <TextInput
          label={t('common.email')}
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          disabled={user !== null}
          description={user ? t('users.emailFixed') : undefined}
        />
        <TextInput label={t('users.name')} value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
        <Select
          label={t('users.colRole')}
          value={role}
          onChange={(v) => setRole((v as 'admin' | 'member') ?? 'member')}
          data={[
            { value: 'member', label: t('users.roleMember') },
            { value: 'admin', label: t('users.roleAdmin') },
          ]}
          disabled={isSelf}
          description={isSelf ? t('users.roleSelf') : undefined}
        />

        {user && (
          <Switch
            checked={isActive}
            onChange={(e) => setIsActive(e.currentTarget.checked)}
            label={t('users.active')}
            disabled={isSelf}
            description={isSelf ? t('users.activeSelf') : t('users.activeHint')}
          />
        )}

        <Box>
          <Text size="sm" fw={500} mb={4}>
            {t('users.orgAccess')}
          </Text>
          <Text size="xs" c="dimmed" mb={6}>
            {t('users.orgNote')}
          </Text>
          <Stack gap={4}>
            {orgs.map((o) => (
              <Group key={o.key} gap="md">
                <Checkbox
                  checked={grants[o.key]?.on ?? false}
                  onChange={(e) =>
                    setGrants((g) => ({ ...g, [o.key]: { on: e.currentTarget.checked, prod: g[o.key]?.prod ?? false } }))
                  }
                  label={
                    <Group gap={6}>
                      <Text size="sm">{o.label}</Text>
                      <Text size="xs" c="dimmed" ff="monospace">
                        {o.key}
                      </Text>
                    </Group>
                  }
                />
                <Checkbox
                  size="xs"
                  color="red"
                  disabled={!grants[o.key]?.on}
                  checked={grants[o.key]?.prod ?? false}
                  onChange={(e) =>
                    setGrants((g) => ({ ...g, [o.key]: { on: g[o.key]?.on ?? false, prod: e.currentTarget.checked } }))
                  }
                  label={<Text size="xs">{t('users.prodRead')}</Text>}
                />
              </Group>
            ))}
            {orgs.length === 0 && (
              <Text size="xs" c="dimmed">
                {t('users.noOrgs')}
              </Text>
            )}
          </Stack>
        </Box>

        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!user && email.trim().length === 0}>
            {user ? t('common.save') : t('users.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
