import { useEffect, useState } from 'react';
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

  /**
   * 선택한 줄보다 실제로 나갈 줄이 적을 때 붙잡아 둔다.
   *
   * 내보내기는 화면이 아니라 **서버 링버퍼**에서 뽑는다. 그런데 화면은 레벨 필터를
   * 통과한 것만 쌓으므로, ERROR 만 보고 있으면 서버가 이미 버린 줄이 화면에는 한참 남는다.
   * 그대로 내려받게 두면 대화상자가 말한 줄 수와 파일이 말없이 어긋난다 —
   * 나중에 그 파일을 근거로 뭔가를 판단할 때 가장 곤란한 종류의 차이다.
   */
  const [shortfall, setShortfall] = useState<{ exportId: string; lines: number } | null>(null);

  // 닫았다 다시 열면 지난번 경고가 남아 있으면 안 된다. 선택이 바뀌었을 수도 있다.
  useEffect(() => {
    if (!opened) return;
    setShortfall(null);
    setError(null);
  }, [opened]);

  const download = (exportId: string): void => {
    // 준비된 내보내기는 받아가는 순간 서버에서 폐기된다.
    window.location.href = `/api/export/${exportId}/download`;
    setShortfall(null);
    onClose();
  };

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    setShortfall(null);
    try {
      const req: ExportRequest = { ...target, format, includeContinuation };
      const { exportId, lines } = await api.prepareExport(req);
      if (lines < lineCount) {
        setShortfall({ exportId, lines });
        return;
      }
      download(exportId);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : t('export.failed'));
    } finally {
      setBusy(false);
    }
  };

  // 포맷·옵션을 바꾸면 준비해둔 것은 그 조건의 결과가 아니다. 다시 물어본다.
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    setShortfall(null);
    set(v);
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

        {shortfall && (
          <Alert color="yellow" variant="light" p="xs">
            <Text size="sm" fw={500}>
              {t('export.shortfall', { want: lineCount, have: shortfall.lines })}
            </Text>
            <Text size="xs" c="dimmed">
              {t('export.shortfallWhy')}
            </Text>
          </Alert>
        )}

        <Radio.Group
          value={format}
          onChange={reset((v: string) => setFormat(v as ExportFormat))}
          label={t('export.format')}
        >
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
          onChange={(e) => reset(setIncludeContinuation)(e.currentTarget.checked)}
          label={t('export.stack')}
        />

        <Text size="xs" c="dimmed">
          {t('export.headerNote')}
        </Text>

        <Group justify="flex-end" gap="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {shortfall ? (
            // 무엇이 나가는지 알고 누르는 것이라 줄 수를 버튼에 박아둔다.
            <Button color="yellow" onClick={() => download(shortfall.exportId)}>
              {t('export.downloadAnyway', { n: shortfall.lines })}
            </Button>
          ) : (
            <Button loading={busy} onClick={() => void submit()}>
              {t('export.submit')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
