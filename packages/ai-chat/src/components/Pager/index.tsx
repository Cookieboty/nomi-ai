/**
 * 分页条（请求明细、对比表、审计日志、活跃会话共用）：
 * - 知道总数（total）：「第 x–y 条，共 N 条」· 上一页 · 页码 · 下一页 · 每页；
 * - 不知道总数（服务端按 offset 取，hasNext 表示还有下一页）：「第 n 页」· 上一页 · 下一页。
 */
import { Icon, Select, t } from '@nomi-ai/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import React from 'react';

import styles from './index.module.css';

export const Pager: React.FC<{
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  /** 总条数；不传时用 hasNext 判断能不能往后翻 */
  total?: number;
  hasNext?: boolean;
  sizes?: number[];
  onPageSize?: (n: number) => void;
  /** rows：对比表的顶层行（项）；requests：请求明细（条） */
  unit?: 'rows' | 'requests';
  /** data-testid 前缀：quality-pager / quality-page-prev …（默认 quality，沿用原来的测试 id） */
  testId?: string;
}> = ({
  page,
  pageSize,
  onPage,
  total,
  hasNext,
  sizes,
  onPageSize,
  unit = 'requests',
  testId = 'quality',
}) => {
  const known = total !== undefined;
  const pages = known ? Math.max(1, Math.ceil(total / pageSize)) : page + (hasNext ? 2 : 1);
  const canNext = known ? page + 1 < pages : !!hasNext;
  const from = known && total ? page * pageSize + 1 : 0;
  const to = known ? Math.min(total, (page + 1) * pageSize) : 0;
  // 页码最多 7 个：首尾 + 当前附近（只在知道总数时显示）
  const nums: Array<number | null> = [];
  if (known)
    for (let i = 0; i < pages; i++) {
      if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 1) nums.push(i);
      else if (nums[nums.length - 1] !== null) nums.push(null);
    }
  return (
    <nav
      className={styles.pager}
      aria-label={t('ui.model-quality.pagination')}
      data-testid={`${testId}-pager`}
    >
      <span className={styles.meta} data-testid={`${testId}-page`}>
        {!known
          ? t('ui.foundation.page-n', page + 1)
          : unit === 'rows'
            ? t('ui.model-quality.showing-of-rows', from, to, total)
            : t('ui.model-quality.showing-of', from, to, total)}
      </span>
      <span className={styles.grow} />
      <button
        type="button"
        className={styles.pageBtn}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
        aria-label={t('ui.usage-tools.previous-page')}
        data-testid={`${testId}-page-prev`}
      >
        <Icon icon={ChevronLeft} size={14} />
      </button>
      {nums.map((p, i) =>
        p === null ? (
          <span key={`gap${i}`} className={styles.meta} aria-hidden>
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={styles.pageBtn}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onPage(p)}
          >
            {p + 1}
          </button>
        ),
      )}
      <button
        type="button"
        className={styles.pageBtn}
        disabled={!canNext}
        onClick={() => onPage(page + 1)}
        aria-label={t('ui.usage-tools.next-page')}
        data-testid={`${testId}-page-next`}
      >
        <Icon icon={ChevronRight} size={14} />
      </button>
      {sizes && onPageSize && (
        <Select
          size="sm"
          variant="ghost"
          className={styles.compactSelect}
          menuMinWidth={120}
          aria-label={t('ui.model-quality.rows-per-page')}
          data-testid={`${testId}-page-size`}
          value={String(pageSize)}
          onChange={(e) => onPageSize(Number(e.target.value))}
          options={sizes.map((n) => ({
            value: String(n),
            label: t('ui.model-quality.per-page', n),
          }))}
        />
      )}
    </nav>
  );
};
