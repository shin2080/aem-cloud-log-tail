import { useEffect, useState } from 'react';
import { ActionIcon, Button, Group, Menu, Modal, Stack, Text, TextInput } from '@mantine/core';
import { api } from '../api/client';
import { useT } from '../i18n';

export interface FilterPayload extends Record<string, unknown> {
  levels: string[];
  query: string;
  regex: boolean;
  /**
   * 상대 구간(분). 절대 시각을 저장하면 다음에 열었을 때 쓸모가 없다.
   * tail 화면에는 구간 개념이 없어 없다.
   */
  rangeMinutes?: number | null;
  /** 분 단위로 바꾸기 전에 저장된 것. 읽기만 한다 */
  rangeHours?: number | null;
}

interface SavedFilter {
  id: string;
  name: string;
  payload: unknown;
  createdAt: number;
}

/**
 * 자주 쓰는 조회 조건 저장.
 * 시각은 절대값 대신 '최근 N시간' 으로 저장한다 — 어제 만든 필터가 오늘도 쓸모 있어야 한다.
 */
export function SavedFilters({
  current,
  onApply,
}: {
  current: FilterPayload;
  onApply: (p: FilterPayload) => void;
}) {
  const t = useT();
  const [filters, setFilters] = useState<SavedFilter[]>([]);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setFilters((await api.filters()).filters);
    } catch {
      // 편의 기능이다. 실패해도 화면을 막지 않는다.
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (name.trim().length === 0) return;
    setError(null);
    try {
      await api.saveFilter(name.trim(), current);
      setSaving(false);
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('filters.saveFailed'));
    }
  };

  return (
    <>
      <Menu position="bottom-start" withArrow closeOnItemClick={false}>
        <Menu.Target>
          <Button size="compact-xs" variant="default">
            {t('filters.label')} {filters.length > 0 ? `(${filters.length})` : ''}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{t('filters.saved')}</Menu.Label>
          {filters.length === 0 && (
            <Menu.Item disabled>
              <Text size="xs" c="dimmed">
                {t('filters.empty')}
              </Text>
            </Menu.Item>
          )}
          {filters.map((f) => (
            <Menu.Item key={f.id} onClick={() => onApply(f.payload as FilterPayload)}>
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Text size="sm">{f.name}</Text>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={(e) => {
                    e.stopPropagation();
                    void api.deleteFilter(f.id).then(load);
                  }}
                >
                  ✕
                </ActionIcon>
              </Group>
            </Menu.Item>
          ))}
          <Menu.Divider />
          <Menu.Item onClick={() => setSaving(true)}>
            <Text size="sm">{t('filters.saveCurrent')}</Text>
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={saving} onClose={() => setSaving(false)} title={t('filters.title')} size="sm">
        <Stack gap="sm">
          <TextInput
            label={t('filters.name')}
            placeholder={t('filters.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            autoFocus
            error={error}
          />
          <Text size="xs" c="dimmed">
            {'rangeMinutes' in current
              ? t('filters.noteSearch')
              : t('filters.noteTail')}
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button variant="subtle" color="gray" onClick={() => setSaving(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={name.trim().length === 0}>
              {t('common.save')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
