/**
 * 问题卡：停在输入栏上方，代理问清楚再继续。
 * 一次只显示一个问题（1 / N），字母选项，最后一行是自己写；Enter 继续，Esc 跳过。
 */
import { Button, Icon, IconButton, t } from '@nomi-ai/ui';
import { ChevronDown, ChevronUp, MessageCircleQuestion } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import styles from './index.module.css';

export interface UserQuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserQuestion {
  id: string;
  prompt: string;
  header?: string;
  multi: boolean;
  options: UserQuestionOption[];
}

export interface UserQuestionRequest {
  id: string;
  source: 'nomi' | 'claude';
  conversationId?: string;
  tabId?: string;
  questions: UserQuestion[];
  expiresAt: number;
}

export interface UserQuestionPick {
  questionId: string;
  selected: string[];
  custom?: string;
}

export interface UserQuestionSubmission {
  action: 'answer' | 'skip';
  answers?: UserQuestionPick[];
  details?: string;
}

const letterOf = (i: number) => (i >= 0 && i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

const emptyPick = (): { selected: string[]; custom: string } => ({ selected: [], custom: '' });

export const UserQuestionCard: React.FC<{
  request: UserQuestionRequest;
  onSubmit: (submission: UserQuestionSubmission) => void;
}> = ({ request, onSubmit }) => {
  const questions = request.questions;
  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [picks, setPicks] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const [details, setDetails] = useState('');
  const pageRef = useRef(page);
  const cursorRef = useRef(cursor);
  const picksRef = useRef(picks);
  const detailsRef = useRef(details);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    pageRef.current = page;
    cursorRef.current = cursor;
    picksRef.current = picks;
    detailsRef.current = details;
  });
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [request.id]);

  const safePage = Math.min(page, Math.max(0, questions.length - 1));
  const question = questions[safePage];
  const pick = question ? (picks[question.id] ?? emptyPick()) : emptyPick();
  const options = question?.options ?? [];
  const customLetter = letterOf(options.length);

  useEffect(() => {
    cardRef.current?.focus();
  }, [request.id]);

  const setPick = (questionId: string, next: { selected: string[]; custom: string }) => {
    setPicks((prev) => ({ ...prev, [questionId]: next }));
  };

  const chooseOption = (index: number) => {
    if (!question) return;
    const opt = options[index];
    if (!opt) return;
    setCursor(index);
    const cur = picksRef.current[question.id] ?? emptyPick();
    if (question.multi) {
      const has = cur.selected.includes(opt.id);
      setPick(question.id, {
        custom: cur.custom,
        selected: has ? cur.selected.filter((id) => id !== opt.id) : [...cur.selected, opt.id],
      });
      return;
    }
    setPick(question.id, { selected: [opt.id], custom: '' });
  };

  const move = (dir: number) => {
    if (!question) return;
    const count = options.length + 1;
    const next = Math.min(count - 1, Math.max(0, cursorRef.current + dir));
    setCursor(next);
    if (!question.multi && next < options.length) {
      const opt = options[next];
      if (opt) setPick(question.id, { selected: [opt.id], custom: '' });
    }
  };

  const go = (next: number) => {
    setPage(next);
    setCursor(0);
  };

  const answers = (): UserQuestionPick[] =>
    questions.map((q) => {
      const p = picksRef.current[q.id] ?? emptyPick();
      return {
        questionId: q.id,
        selected: p.selected,
        ...(p.custom.trim() ? { custom: p.custom.trim() } : {}),
      };
    });

  const continueOn = () => {
    const i = pageRef.current;
    if (i < questions.length - 1) {
      go(i + 1);
      return;
    }
    const note = detailsRef.current.trim();
    onSubmit({ action: 'answer', answers: answers(), ...(note ? { details: note } : {}) });
  };

  const skip = () => {
    const note = detailsRef.current.trim();
    onSubmit({ action: 'skip', ...(note ? { details: note } : {}) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key === 'Process') return;
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as HTMLElement | null;
      const inCard = !!target && root.contains(target);
      const focusInCard =
        !!document.activeElement &&
        (root.contains(document.activeElement) || document.activeElement === cardRef.current);
      const field = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      const foreignField = !inCard && field;
      if (foreignField) {
        const value = (target as HTMLInputElement).value ?? '';
        if (value !== '' || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      }
      if (inCard && field && e.key !== 'Enter' && e.key !== 'Escape') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!inCard && !foreignField && !focusInCard && e.key !== 'Enter' && e.key !== 'Escape')
        return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        skip();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        continueOn();
        return;
      }
      if (field) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key.length === 1) {
        const idx = e.key.toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) {
          e.preventDefault();
          e.stopPropagation();
          chooseOption(idx);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // 选项列表变了才重绑；翻页和选择走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.id, safePage, options.length, question?.multi]);

  if (!question) return null;
  const seconds = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const mm = String(Math.floor(seconds / 60));
  const ss = String(seconds % 60).padStart(2, '0');

  return (
    <div ref={rootRef} className={styles.dock} data-testid="user-question-dock">
      <div
        ref={cardRef}
        className={styles.card}
        tabIndex={-1}
        role="group"
        aria-label={t('ui.chat-settings.question-card-label')}
        data-testid="user-question-card"
      >
        <div className={styles.head}>
          <Icon icon={MessageCircleQuestion} size={16} />
          <span className={styles.title}>{t('ui.chat-settings.questions-title')}</span>
          {questions.length > 1 && (
            <span className={styles.pager}>
              <IconButton
                label={t('ui.chat-settings.question-prev')}
                icon={<ChevronUp size={14} />}
                size="sm"
                disabled={safePage === 0}
                onClick={() => go(safePage - 1)}
                data-testid="user-question-prev"
              />
              <span className={styles.page} data-testid="user-question-page">
                {t(
                  'ui.chat-settings.questions-page',
                  String(safePage + 1),
                  String(questions.length),
                )}
              </span>
              <IconButton
                label={t('ui.chat-settings.question-next')}
                icon={<ChevronDown size={14} />}
                size="sm"
                disabled={safePage >= questions.length - 1}
                onClick={() => go(safePage + 1)}
                data-testid="user-question-next"
              />
            </span>
          )}
          <span className={styles.timer}>
            {t('ui.chat-settings.question-time-left', `${mm}:${ss}`)}
          </span>
        </div>
        {question.header && <div className={styles.header}>{question.header}</div>}
        <p className={styles.prompt}>
          <span className={styles.num}>{safePage + 1}.</span> {question.prompt}
        </p>
        {question.multi && <p className={styles.multi}>{t('ui.chat-settings.question-multi')}</p>}
        <div className={styles.options} role={question.multi ? 'group' : 'radiogroup'}>
          {options.map((opt, i) => {
            const on = pick.selected.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                className={on ? styles.optionOn : styles.option}
                data-testid="user-question-option"
                data-letter={letterOf(i)}
                aria-pressed={on}
                onClick={() => chooseOption(i)}
              >
                <span className={styles.letter}>{letterOf(i)}</span>
                <span className={styles.optionBody}>
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {opt.description && <span className={styles.optionDesc}>{opt.description}</span>}
                </span>
              </button>
            );
          })}
          <label
            className={cursor === options.length && pick.custom ? styles.optionOn : styles.option}
            data-testid="user-question-custom-row"
          >
            <span className={styles.letter}>{customLetter}</span>
            <input
              className={styles.custom}
              data-testid="user-question-custom"
              aria-label={t('ui.chat-settings.question-type-own')}
              placeholder={t('ui.chat-settings.question-type-own')}
              value={pick.custom}
              onFocus={() => setCursor(options.length)}
              onChange={(e) => {
                const custom = e.target.value;
                if (!question.multi && custom) {
                  setPick(question.id, { selected: [], custom });
                } else {
                  setPick(question.id, { selected: pick.selected, custom });
                }
              }}
            />
          </label>
        </div>
        <div className={styles.actions}>
          <Button type="button" size="sm" onClick={skip} data-testid="user-question-skip">
            {t('ui.chat-settings.question-skip')}
            <kbd className={styles.kbd}>Esc</kbd>
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={continueOn}
            data-testid="user-question-continue"
          >
            {t('ui.chat-settings.question-continue')}
            <kbd className={styles.kbd}>Enter</kbd>
          </Button>
        </div>
      </div>
      <input
        className={styles.details}
        data-testid="user-question-details"
        placeholder={t('ui.chat-settings.question-details-placeholder')}
        aria-label={t('ui.chat-settings.question-details-placeholder')}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
      />
    </div>
  );
};
