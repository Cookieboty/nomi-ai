import type { LicenseTermsView } from '@nomi-ai/types';
import { t } from '@nomi-ai/ui';
import { Badge, Modal } from '@nomi-ai/ui';
import React from 'react';

import styles from './style.module.css';

import { useMascot } from '@/contexts/MascotContext';
import { conditionsText, licenseLabel } from '@/mascot/licenseTerms';

interface CreditRow {
  key: string;
  title: string;
  author: string;
  license: string;
  source?: string;
  note?: string;
  termsUrl?: string;
  licenseFileUrl?: string;
}

/** 署名要求（CC-BY 等）必须展示作者；CC0 也一并列出以示感谢。 */
export function collectCredits(
  models: Array<{
    name: string;
    displayName: string;
    author: string;
    license: string;
    source?: string;
    licenseTerms?: LicenseTermsView;
    licenseFileUrl?: string;
  }>,
): CreditRow[] {
  const rows: CreditRow[] = models.map((m) => ({
    key: `model-${m.name}`,
    title: m.displayName,
    author: m.author,
    license: m.license,
    source: m.source,
    note: conditionsText(m.licenseTerms),
    termsUrl: m.licenseTerms?.url,
    licenseFileUrl: m.licenseFileUrl,
  }));
  rows.push({
    key: 'ui-icons',
    title: t('工具栏图标'),
    author: 'Lucide contributors',
    license: 'ISC',
    source: 'https://lucide.dev/license',
  });
  rows.push({
    key: 'icon',
    title: t('应用图标'),
    author: 'Cookieboty',
    license: 'First-party',
    note: t('作者原创，保留所有权利'),
  });
  return rows;
}

/** 致谢 / Credits：列出内置角色与图标的作者与许可。 */
export const Credits: React.FC = () => {
  const { state, dispatch } = useMascot();
  if (state.panel !== 'credits') return null;
  const rows = collectCredits(state.modelList);

  return (
    <Modal
      open
      onClose={() => dispatch({ type: 'SET_PANEL', payload: null })}
      title={t('致谢 / Credits')}
      data-testid="credits"
    >
      <ul className={styles.credits}>
        {rows.map((r) => (
          <li key={r.key} data-testid={`credit-${r.key}`}>
            <div className={styles.creditHead}>
              <strong>{t(r.title)}</strong>
              <Badge
                tone={r.license.startsWith('CC-BY') ? 'accent' : r.termsUrl ? 'warning' : 'neutral'}
              >
                {licenseLabel(r.license)}
              </Badge>
            </div>
            <div className={styles.creditMeta}>
              {r.author}
              {r.note ? ` · ${r.note}` : ''}
            </div>
            {r.source && <div className={styles.creditSource}>{r.source}</div>}
            {r.termsUrl && (
              <div className={styles.creditSource}>
                {t('条款：')}
                {r.termsUrl}
              </div>
            )}
            {r.licenseFileUrl && (
              <div className={styles.creditSource}>
                {t('许可文件：')}
                {r.licenseFileUrl}
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className={styles.credit}>
        {t('完整清单见 THIRD_PARTY_NOTICES.md 与 assets-licenses.json。')}
      </p>
    </Modal>
  );
};

export default Credits;
