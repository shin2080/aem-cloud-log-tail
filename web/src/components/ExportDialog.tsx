import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Radio, Stack, Text } from '@mantine/core';
import type { ExportFormat, ExportRequest } from '@shared/types';
import { api, ApiRequestError } from '../api/client';
import { useT, type StringKey } from '../i18n';

export interface ExportTarget {
  source: 'tail' | 'search';
  sessionId?: string;
  jobId?: string;
  seqFrom?: number;
  seqTo?: number;
  /** 화면에 보이는 줄의 seq. 묶어보기·북마크만보기에서 구간과 실제가 다를 때 채운다 */
  seqs?: number[];
}

const FORMATS: { value: ExportFormat; label: string; hint: StringKey }[] = [
  { value: 'log', label: 'log', hint: 'export.hintLog' },
  { value: 'json', label: 'json', hint: 'export.hintJson' },
  { value: 'csv', label: 'csv', hint: 'export.hintCsv' },
];

export function ExportDialog({
  opened,
  onClose,
  target,
  lineCount,
}: {
  opened: boolean;
  onClose: () => void;
  target: ExportTarget | null;
  lineCount: number;
}) {
  const t = useT();
  const [format, setFormat] = useState<ExportFormat>('log');
  const [includeContinuation, setIncludeContinuation] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const req: ExportRequest = { ...target, format, includeContinuation };
      const { exportId } = await api.prepareExport(req);
      // 준비된 내보내기는 받아가는 순간 서버에서 폐기된다.
      window.location.href = `/api/export/${exportId}/download`;
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('export.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('export.title')} size="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          {t('export.lines', { n: lineCount })}
        </Text>

        {error && (
          <Alert color="red" variant="light" p="xs">
            <Text size="sm">{error}</Text>
          </Alert>
        )}

        <Radio.Group value={format} onChange={(v) => setFormat(v as ExportFormat)} label={t('export.format')}>
          <Stack gap={6} mt={6}>
            {FORMATS.map((f) => (
              <Radio
                key={f.value}
                value={f.value}
                label={
                  <Group gap={6}>
                    <Text size="sm" ff="monospace">
                      {f.label}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t(f.hint)}
                    </Text>
                  </Group>
                }
              />
            ))}
          </Stack>
        </Radio.Group>

        <Checkbox
          checked={includeContinuation}
          onChange={(e) => setIncludeContinuation(e.currentTarget.checked)}
          label={t('export.stack')}
        />

        <Text size="xs" c="dimmed">
          {t('export.headerNote')}
        </Text>

        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {t('export.submit')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
