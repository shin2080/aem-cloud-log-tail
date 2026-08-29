import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Box, Button, Code, Group, Select, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { api, ApiRequestError } from '../api/client';
import { useT } from '../i18n';

export interface AuditRow {
  id: number;
  at: number;
  userId: string | null;
  userEmail: string;
  action: string;
  orgKey: string | null;
  environmentId: string | null;
  environmentType: string | null;
  detail: unknown;
  ip: string | null;
}

const PAGE = 100;

/** 색은 상태를 나타낼 때만 쓴다. 실패와 관리자 조작만 눈에 띄면 된다. */
const ACTION_COLOR: Record<string, string> = {
  login_failed: 'red',
  admin_user_create: 'yellow',
  admin_user_update: 'yellow',
  admin_user_delete: 'red',
  admin_password_reset: 'yellow',
  export: 'blue',
};

const fmt = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

export function AdminAuditPage() {
  const t = useT();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [from, setFrom] = useState<Date | null>(null);
  const [to, setTo] = useState<Date | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError(null);
      try {
        const r = await api.adminAudit({
          from: from?.getTime(),
          to: to?.getTime(),
          action: action ?? undefined,
          q: q.trim() || undefined,
          limit: PAGE,
          offset: nextOffset,
        });
        setRows(r.rows);
        setTotal(r.total);
        setActions(r.actions);
        setOffset(nextOffset);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : t('audit.loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [from, to, action, q],
  );

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between">
        <Title order={5}>{t('audit.title')}</Title>
        <Text size="xs" c="dimmed">
          {t('audit.readOnly')}
        </Text>
      </Group>

      <Group gap="xs" wrap="wrap">
        <DateTimePicker size="xs" placeholder={t('common.from')} value={from} onChange={(v) => setFrom(v ? new Date(v) : null)} w={185} clearable />
        <DateTimePicker size="xs" placeholder={t('common.to')} value={to} onChange={(v) => setTo(v ? new Date(v) : null)} w={185} clearable />
        <Select
          size="xs"
          placeholder={t('audit.actionAll')}
          value={action}
          onChange={setAction}
          data={actions.map((a) => ({ value: a, label: a }))}
          clearable
          w={190}
        />
        <TextInput
          size="xs"
          placeholder={t('audit.findEmail')}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(0)}
          w={190}
        />
        <Button size="compact-xs" loading={loading} onClick={() => void load(0)}>
          {t('common.run')}
        </Button>
        <Text size="xs" c="dimmed">
          {t('common.count', { n: total })}
        </Text>
      </Group>

      {error && (
        <Alert color="red" variant="light" p="xs">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      <Box style={{ overflowX: 'auto' }}>
        <Table highlightOnHover verticalSpacing={4} style={{ fontSize: 12 }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ whiteSpace: 'nowrap' }}>{t('audit.colTime', { tz: 'KST' })}</Table.Th>
              <Table.Th>{t('audit.colAccount')}</Table.Th>
              <Table.Th>{t('audit.colAction')}</Table.Th>
              <Table.Th>{t('audit.colTarget')}</Table.Th>
              <Table.Th>detail</Table.Th>
              <Table.Th>IP</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>
                  <Text size="xs" ff="monospace" style={{ whiteSpace: 'nowrap' }}>
                    {fmt(r.at)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" ff="monospace">
                    {r.userEmail}
                  </Text>
                </Table.Td>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>
                  {/* Badge 는 기본으로 대문자화 + 말줄임을 한다. action 이름이 길어 잘리므로 둘 다 끈다. */}
                  <Badge
                    size="xs"
                    variant="light"
                    color={ACTION_COLOR[r.action] ?? 'gray'}
                    styles={{ label: { overflow: 'visible', textOverflow: 'clip' } }}
                    style={{ textTransform: 'none', maxWidth: 'none', fontFamily: 'var(--mantine-font-family-monospace)' }}
                  >
                    {r.action}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {r.orgKey && (
                    <Text size="xs" ff="monospace" c="dimmed">
                      {r.orgKey}
                      {r.environmentId ? `/${r.environmentId}` : ''}
                      {r.environmentType ? ` (${r.environmentType})` : ''}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td style={{ maxWidth: 420 }}>
                  {r.detail !== null && (
                    <Code style={{ fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)}
                    </Code>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {r.ip ?? ''}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>

      {rows.length === 0 && !loading && (
        <Text size="sm" c="dimmed">
          {t('audit.empty')}
        </Text>
      )}

      {total > PAGE && (
        <Group gap="xs" justify="center">
          <Button size="compact-xs" variant="default" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - PAGE))}>
            {t('common.prev')}
          </Button>
          <Text size="xs" c="dimmed">
            {offset + 1}–{Math.min(offset + PAGE, total)} / {total.toLocaleString()}
          </Text>
          <Button
            size="compact-xs"
            variant="default"
            disabled={offset + PAGE >= total}
            onClick={() => void load(offset + PAGE)}
          >
            {t('common.next')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
