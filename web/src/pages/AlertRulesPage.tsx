import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useSearchParams } from 'react-router-dom';
import type { LogLevel } from '@shared/types';
import { api, ApiRequestError } from '../api/client';
import type { AlertRule } from '../api/alerts';
import { useT, type StringKey } from '../i18n';

const ALL_LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
const COOLDOWNS = [0, 60, 300, 900, 3600];

/** 스스로 꺼진 규칙은 왜 꺼졌는지 말해줘야 한다. 조용히 꺼지면 알림이 안 오는 걸 모른다. */
function disabledLabel(reason: string | null): StringKey | null {
  switch (reason) {
    case 'access_revoked':
      return 'rules.disabledBy.access_revoked';
    case 'too_many_targets':
      return 'rules.disabledBy.too_many_targets';
    case 'pattern_dangerous':
      return 'rules.disabledBy.pattern_dangerous';
    case 'pattern_invalid':
    case 'pattern_empty':
    case 'pattern_too_long':
      return 'rules.disabledBy.pattern_invalid';
    default:
      return null;
  }
}

export function AlertRulesPage() {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [maxTargets, setMaxTargets] = useState(0);
  const [watched, setWatched] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.alertRules();
      setRules(r.rules);
      setMaxTargets(r.maxTargets);
      setWatched(r.watchedTargets);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 창에서 "이 조건으로 알림 만들기" 를 누르면 대상과 조건이 실려서 들어온다.
  const prefill = useMemo(() => {
    const p = search.get('p');
    if (!p) return null;
    const [org, env, service, logName] = p.split(':');
    if (!org || !env || !service || !logName) return null;
    return {
      org,
      env,
      service,
      logName,
      pattern: search.get('q') ?? '',
      isRegex: search.get('re') === '1',
      levels: (search.get('levels')?.split(',').filter(Boolean) ?? []) as LogLevel[],
    };
  }, [search]);

  useEffect(() => {
    if (prefill) setAdding(true);
  }, [prefill]);

  const closeAdd = (): void => {
    setAdding(false);
    if (search.has('p')) setSearch(new URLSearchParams(), { replace: true });
  };

  const targetsFull = watched.length >= maxTargets && maxTargets > 0;

  return (
    <Box p="md">
      <Group justify="space-between" align="flex-start" mb="md">
        <div>
          <Title order={4}>{t('rules.title')}</Title>
          <Text size="xs" c="dimmed">
            {t('rules.subtitle')}
          </Text>
        </div>
        <Group gap="xs">
          <Badge variant="light" color={targetsFull ? 'yellow' : 'gray'}>
            {t('rules.targets', { n: watched.length, max: maxTargets })}
          </Badge>
          <Button size="compact-sm" onClick={() => setAdding(true)} disabled={maxTargets === 0}>
            {t('rules.add')}
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" mb="md" p="xs">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      {targetsFull && (
        <Alert color="yellow" variant="light" mb="md" p="xs">
          <Text size="sm">{t('rules.targetsFull')}</Text>
        </Alert>
      )}

      {rules.length === 0 ? (
        <Stack gap={2} align="center" py="xl">
          <Text size="sm">{t('rules.empty')}</Text>
          <Text size="xs" c="dimmed">
            {t('rules.emptyHint')}
          </Text>
        </Stack>
      ) : (
        <Stack gap="xs">
          {rules.map((r) => {
            const why = r.enabled ? null : disabledLabel(r.disabledReason);
            return (
              <Paper key={r.id} withBorder p="sm">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Box style={{ minWidth: 0 }}>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600} truncate>
                        {r.name}
                      </Text>
                      {r.isRegex && (
                        <Badge size="xs" variant="outline" color="gray">
                          .*
                        </Badge>
                      )}
                      {why && (
                        <Badge size="xs" color="yellow" variant="light">
                          {t(why)}
                        </Badge>
                      )}
                    </Group>
                    <Text size="xs" ff="monospace" c="dimmed" truncate>
                      {r.pattern}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {r.orgKey} · {r.environmentId} · {r.service} · {r.logName}
                      {r.levels.length > 0 && ` · ${r.levels.join('/')}`}
                      {' · '}
                      {r.cooldownSec === 0 ? t('rules.cooldownOff') : t('rules.min', { n: Math.round(r.cooldownSec / 60) })}
                    </Text>
                  </Box>
                  <Group gap="xs" wrap="nowrap">
                    <Switch
                      size="sm"
                      aria-label={r.enabled ? t('rules.enabled') : t('rules.disabled')}
                      checked={r.enabled}
                      onChange={(e) =>
                        void api
                          .setAlertRuleEnabled(r.id, e.currentTarget.checked)
                          .then(load)
                          .catch(() => {})
                      }
                    />
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() => void api.deleteAlertRule(r.id).then(load).catch(() => {})}
                    >
                      {t('rules.delete')}
                    </Button>
                  </Group>
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}

      <AddRuleModal opened={adding} onClose={closeAdd} onCreated={load} prefill={prefill} />
    </Box>
  );
}

function AddRuleModal({
  opened,
  onClose,
  onCreated,
  prefill,
}: {
  opened: boolean;
  onClose: () => void;
  onCreated: () => Promise<void>;
  prefill: {
    org: string;
    env: string;
    service: string;
    logName: string;
    pattern: string;
    isRegex: boolean;
    levels: LogLevel[];
  } | null;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [levels, setLevels] = useState<LogLevel[]>(['ERROR']);
  const [cooldown, setCooldown] = useState('300');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    setError(null);
    setName('');
    setPattern(prefill?.pattern ?? '');
    setIsRegex(prefill?.isRegex ?? false);
    setLevels(prefill?.levels.length ? prefill.levels : ['ERROR']);
  }, [opened, prefill]);

  const submit = async (): Promise<void> => {
    if (!prefill) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAlertRule({
        name: name.trim() || pattern.trim(),
        org: prefill.org,
        env: prefill.env,
        service: prefill.service,
        logName: prefill.logName,
        pattern: pattern.trim(),
        isRegex,
        levels,
        cooldownSec: Number(cooldown),
      });
      await onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('rules.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('rules.add')} size="md">
      <Stack gap="md">
        {!prefill ? (
          // 대상은 창에서 들고 온다. 여기서 환경 고르기를 다시 만들면 같은 UI 가 둘이 된다.
          <Text size="sm" c="dimmed">
            {t('rules.emptyHint')}
          </Text>
        ) : (
          <>
            {error && (
              <Alert color="red" variant="light" p="xs">
                <Text size="sm">{error}</Text>
              </Alert>
            )}

            <Box>
              <Text size="xs" c="dimmed">
                {t('rules.target')}
              </Text>
              <Text size="sm" ff="monospace">
                {prefill.org} · {prefill.env} · {prefill.service} · {prefill.logName}
              </Text>
            </Box>

            <TextInput
              label={t('rules.name')}
              placeholder={t('rules.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />

            <TextInput
              label={t('rules.pattern')}
              placeholder={t('rules.patternPlaceholder')}
              value={pattern}
              onChange={(e) => setPattern(e.currentTarget.value)}
              required
            />

            <Checkbox
              label={t('rules.regex')}
              description={t('rules.regexNote')}
              checked={isRegex}
              onChange={(e) => setIsRegex(e.currentTarget.checked)}
            />

            <Checkbox.Group label={t('rules.levels')} value={levels} onChange={(v) => setLevels(v as LogLevel[])}>
              <Group gap="md" mt={6}>
                {ALL_LEVELS.map((l) => (
                  <Checkbox key={l} value={l} label={l} size="xs" />
                ))}
              </Group>
            </Checkbox.Group>

            <Select
              label={t('rules.cooldown')}
              description={t('rules.cooldownNote')}
              value={cooldown}
              onChange={(v) => setCooldown(v ?? '300')}
              data={COOLDOWNS.map((s) => ({
                value: String(s),
                label: s === 0 ? t('rules.cooldownOff') : t('rules.min', { n: Math.round(s / 60) }),
              }))}
            />

            <Group justify="flex-end" gap="xs">
              <Button variant="subtle" color="gray" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button loading={busy} onClick={() => void submit()} disabled={pattern.trim().length === 0}>
                {t('rules.add')}
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Modal>
  );
}
