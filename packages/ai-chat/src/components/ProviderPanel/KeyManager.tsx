import { t as tr, Icon } from '@nomi-ai/ui';
import { Badge, Button, Input } from '@nomi-ai/ui';
import { Lock, TriangleAlert } from 'lucide-react';
import React, { useState } from 'react';

import { providerClient, type ProviderView, type TestResult } from '../../services/providerClient';

import styles from './index.module.css';
import { TestBadge } from './shared';

/** Token 列表：掩码 / 主备 / 轮换 / 测试 / 删除 / 添加备用。明文只单向提交。 */
export const KeyManager: React.FC<{ p: ProviderView; onError: (e: unknown) => void }> = ({
  p,
  onError,
}) => {
  const [newKey, setNewKey] = useState('');
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateValue, setRotateValue] = useState('');
  const [tests, setTests] = useState<Record<string, TestResult | 'pending'>>({});
  const run = (fn: () => Promise<unknown>) => () => void fn().catch(onError);
  const test = (keyId: string) =>
    run(async () => {
      setTests((t) => ({ ...t, [keyId]: 'pending' }));
      const r = await providerClient.test(p.id, keyId);
      setTests((t) => ({ ...t, [keyId]: r }));
    });

  return (
    <div className={styles.keys}>
      {p.keys.length === 0 && <div className="cd-muted">{tr('未配置 Token')}</div>}
      {p.keys.map((k, i) => (
        <div key={k.id} className={styles.keyRow}>
          <code className="cd-code" data-testid="masked-key">
            {k.masked}
          </code>
          <Badge tone={i === 0 ? 'accent' : 'neutral'}>
            {i === 0 ? tr('主') : tr('备用 {0}', i)}
          </Badge>
          {k.encryption === 'none' ? (
            <Badge tone="warning" icon={TriangleAlert}>
              {tr('未加密')}
            </Badge>
          ) : (
            <span className="cd-muted" title={tr('safeStorage 加密')}>
              <Icon icon={Lock} size={14} />
            </span>
          )}
          {k.lastError && (
            <Badge tone="danger" title={k.lastError}>
              {tr('上次失败')}
            </Badge>
          )}
          <span className="cd-spacer" />
          {i > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={run(() => providerClient.promoteKey(p.id, k.id))}
            >
              {tr('设为主')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRotating(rotating === k.id ? null : k.id)}
          >
            {tr('轮换')}
          </Button>
          <Button size="sm" variant="ghost" onClick={test(k.id)}>
            {tr('测试')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={run(() => providerClient.removeKey(p.id, k.id))}
          >
            {tr('删除')}
          </Button>
          <TestBadge r={tests[k.id]} />
          {rotating === k.id && (
            <div className={styles.inline}>
              <Input
                size="sm"
                type="password"
                placeholder={tr('新的 Token')}
                value={rotateValue}
                autoComplete="off"
                onChange={(e) => setRotateValue(e.target.value)}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!rotateValue.trim()}
                onClick={run(async () => {
                  await providerClient.rotateKey(p.id, k.id, rotateValue);
                  setRotateValue('');
                  setRotating(null);
                })}
              >
                {tr('保存')}
              </Button>
            </div>
          )}
        </div>
      ))}
      <div className={styles.inline}>
        <Input
          size="sm"
          type="password"
          placeholder={tr('添加备用 Token（主 Token 失败时自动切换）')}
          value={newKey}
          autoComplete="off"
          onChange={(e) => setNewKey(e.target.value)}
        />
        <Button
          size="sm"
          disabled={!newKey.trim()}
          onClick={run(async () => {
            await providerClient.addKey(p.id, newKey);
            setNewKey('');
          })}
        >
          {tr('添加')}
        </Button>
      </div>
    </div>
  );
};
