/** Nomi的 MCP UI 定制：只把上游请求头文本框换成 K–V 行，保存仍交给 extClient.parseKv。 */
import { Button, Icon, IconButton, Input, t } from '@nomi-ai/ui';
import { Plus, Trash2 } from 'lucide-react';
import React, { useRef, useState } from 'react';

import styles from './McpHeaderRows.module.css';

interface HeaderRow {
  id: number;
  key: string;
  value: string;
}

function rowsFromText(text: string): HeaderRow[] {
  const rows = text.split('\n').flatMap((line, id) => {
    const split = line.indexOf('=');
    return split < 0 ? [] : [{ id, key: line.slice(0, split), value: line.slice(split + 1) }];
  });
  return rows.length ? rows : [{ id: 0, key: '', value: '' }];
}

export function McpHeaderRows({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [rows, setRows] = useState(() => rowsFromText(value));
  const [seenValue, setSeenValue] = useState(value);
  const nextId = useRef(value.split('\n').length);
  if (value !== seenValue) {
    setSeenValue(value);
    setRows(rowsFromText(value));
  }
  function update(next: HeaderRow[]) {
    const text = next.map((row) => `${row.key}=${row.value}`).join('\n');
    setRows(next);
    setSeenValue(text);
    onChange(text);
  }
  return (
    <div className={styles.stack} data-testid="mcp-headers">
      <span>{t('ui.foundation.mcp-request-headers')}</span>
      {rows.map((row, index) => (
        <div className={styles.row} key={row.id} data-testid="mcp-header-row">
          <Input
            size="sm"
            value={row.key}
            placeholder="Key"
            aria-label={t('ui.foundation.mcp-header-key', index + 1)}
            data-testid={`mcp-header-key-${index}`}
            onChange={(event) =>
              update(
                rows.map((entry) =>
                  entry.id === row.id ? { ...entry, key: event.target.value } : entry,
                ),
              )
            }
          />
          <Input
            size="sm"
            value={row.value}
            placeholder="Value"
            aria-label={t('ui.foundation.mcp-header-value', index + 1)}
            data-testid={`mcp-header-value-${index}`}
            onChange={(event) =>
              update(
                rows.map((entry) =>
                  entry.id === row.id ? { ...entry, value: event.target.value } : entry,
                ),
              )
            }
          />
          <IconButton
            size="sm"
            icon={<Icon icon={Trash2} size={14} />}
            label={t('ui.foundation.mcp-header-remove', index + 1)}
            data-testid={`mcp-header-remove-${index}`}
            onClick={() => update(rows.filter((entry) => entry.id !== row.id))}
          />
        </div>
      ))}
      <div>
        <Button
          size="sm"
          data-testid="mcp-header-add"
          onClick={() => {
            const id = Math.max(nextId.current, ...rows.map((row) => row.id + 1));
            nextId.current = id + 1;
            update([...rows, { id, key: '', value: '' }]);
          }}
        >
          <Icon icon={Plus} size={14} />
          {t('ui.foundation.mcp-header-add')}
        </Button>
      </div>
    </div>
  );
}
