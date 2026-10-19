import fs from 'node:fs';
import path from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Inbox, Settings } from 'lucide-react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ErrorState,
  LoadingState,
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
  Icon,
  IconButton,
  Input,
  Modal,
  ModalHostContext,
  Notice,
  Select,
  SectionTitle,
  Switch,
  Tabs,
  ToastProvider,
  Tooltip,
  applyLocale,
  useToast,
} from '../src';

afterEach(cleanup);

describe('@nomi-ai/ui', () => {
  it('SectionTitle keeps the requested heading level and shared class', () => {
    const { rerender } = render(<SectionTitle level={2}>Overview</SectionTitle>);
    expect(screen.getByRole('heading', { level: 2 }).className).toContain('cd-section-title');
    rerender(<SectionTitle level={4}>Details</SectionTitle>);
    expect(screen.getByRole('heading', { level: 4 }).textContent).toBe('Details');
  });

  it('EmptyState: lucide icon sits in the rounded tinted container (no emoji)', () => {
    const { container } = render(<EmptyState icon={Inbox} title="还没有内容" />);
    const box = container.querySelector('.cd-empty__icon');
    expect(box).toBeTruthy();
    const svg = box!.querySelector('svg');
    expect(svg?.getAttribute('stroke-width')).toBe('1.75');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('width')).toBe('22');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Icon: presets map to nav 18 / inline 16', () => {
    const { container } = render(
      <>
        <Icon icon={Settings} size="nav" />
        <Icon icon={Settings} />
      </>,
    );
    const w = [...container.querySelectorAll('svg')].map((n) => n.getAttribute('width'));
    expect(w).toEqual(['18', '16']);
  });

  it('Button: variants map to classes, default type=button, passes data-testid', () => {
    render(
      <Button variant="primary" size="sm" data-testid="b">
        Go
      </Button>,
    );
    const b = screen.getByTestId('b');
    expect(b.className).toBe('cd-btn cd-btn--primary cd-btn--sm');
    expect(b.getAttribute('type')).toBe('button');
  });

  it('IconButton: label becomes aria-label and title', () => {
    render(<IconButton label="设置" icon={<Icon icon={Settings} />} />);
    const b = screen.getByRole('button', { name: '设置' });
    expect(b.getAttribute('title')).toBe('设置');
    expect(b.className).toContain('cd-icon-btn');
  });

  it('Select renders options and stays a native select', () => {
    const onChange = vi.fn();
    render(
      <Select
        data-testid="s"
        value="a"
        onChange={(e) => onChange(e.target.value)}
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
        ]}
      />,
    );
    const s = screen.getByTestId('s') as HTMLSelectElement;
    expect(s.tagName).toBe('SELECT');
    expect(s.options).toHaveLength(2);
    expect(s.options[1].disabled).toBe(true);
  });

  it('Switch toggles via click with role=switch', () => {
    const Demo = () => {
      const [on, setOn] = useState(false);
      return <Switch checked={on} onChange={setOn} label="启用" />;
    };
    render(<Demo />);
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('Modal: hidden when closed; Esc / overlay / close button call onClose', () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal open={false} onClose={onClose} title="T">
        body
      </Modal>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <Modal open onClose={onClose} title="T" data-testid="m">
        body
      </Modal>,
    );
    const dlg = screen.getByRole('dialog', { name: 'T' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    fireEvent.click(dlg); // 内容区点击不关闭
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(dlg.parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('Modal: focus moves in, Tab wraps, Esc closes only the top dialog, focus returns', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    const Host: React.FC<{ innerOpen: boolean }> = ({ innerOpen }) => (
      <>
        <button data-testid="opener">open</button>
        <Modal open onClose={outer} title="Outer">
          <input aria-label="a" />
          <button>b</button>
          <Modal open={innerOpen} onClose={inner} title="Inner">
            <button>c</button>
          </Modal>
        </Modal>
      </>
    );
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender, unmount } = render(<Host innerOpen={false} />);
    const dlg = screen.getByRole('dialog', { name: 'Outer' });
    expect(dlg.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('a');
    // 首个可聚焦元素是标题栏的关闭按钮；最后一个是 b：两端循环
    const close = screen.getByRole('button', { name: '关闭' });
    const b = screen.getByRole('button', { name: 'b' });
    b.focus();
    fireEvent.keyDown(b, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(b);

    rerender(<Host innerOpen />);
    expect(screen.getByRole('dialog', { name: 'Inner' }).contains(document.activeElement)).toBe(
      true,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    rerender(<Host innerOpen={false} />);
    expect(dlg.contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('ErrorState: alert role, detail, retry; LoadingState: busy skeleton', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ErrorState title="下载失败" detail="HTTP 503" onRetry={onRetry} retryTestId="retry" />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('下载失败');
    expect(alert.textContent).toContain('HTTP 503');
    fireEvent.click(screen.getByTestId('retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState detail="x" onRetry={onRetry} retrying retryTestId="retry" />);
    expect((screen.getByTestId('retry') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('出错了');
    cleanup();
    render(<LoadingState rows={2} label="加载中" data-testid="ld" />);
    expect(screen.getByTestId('ld').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('Tabs: click and arrow keys change selection', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        items={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
        value="a"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(onChange.mock.calls).toEqual([['b'], ['b']]);
  });

  it('Card / Badge / EmptyState / Notice render their slots', () => {
    render(
      <Card
        title="Title"
        subtitle="Sub"
        actions={<Badge tone="success">ok</Badge>}
        active
        data-testid="c"
      >
        <EmptyState title="空" description="暂无" />
        <Notice tone="danger">err</Notice>
      </Card>,
    );
    expect(screen.getByTestId('c').className).toContain('cd-card--active');
    expect(screen.getByText('ok').className).toBe('cd-badge cd-badge--success');
    expect(screen.getByText('暂无')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('err');
  });

  it('FormField associates label + hint with the control', () => {
    render(
      <FormField label="名称" hint="提示">
        <Input data-testid="i" />
      </FormField>,
    );
    const i = screen.getByLabelText('名称');
    expect(i).toBe(screen.getByTestId('i'));
    expect(document.getElementById(i.getAttribute('aria-describedby')!)!.textContent).toBe('提示');
  });

  it('Tooltip links bubble via aria-describedby', () => {
    render(
      <Tooltip content="提示文本">
        <button>btn</button>
      </Tooltip>,
    );
    const b = screen.getByRole('button', { name: 'btn' });
    expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toBe(
      '提示文本',
    );
  });

  it('Tooltip top-end anchors the bubble to the trigger right edge (no clipping at container edge)', () => {
    render(
      <Tooltip content="靠右按钮" placement="top-end">
        <button>edge</button>
      </Tooltip>,
    );
    const bubble = screen.getByRole('tooltip', { hidden: true });
    expect(bubble.className).toContain('cd-tooltip__bubble--top-end');
  });

  it('Tooltip bottom-start anchors to the trigger left edge; long text wraps instead of overflowing', async () => {
    render(
      <Tooltip content="很长的说明" placement="bottom-start">
        <button>left</button>
      </Tooltip>,
    );
    expect(screen.getByRole('tooltip', { hidden: true }).className).toContain(
      'cd-tooltip__bubble--bottom-start',
    );
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/base.css'), 'utf8');
    const rule = /\.cd-tooltip__bubble \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).not.toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/max-width:/);
  });

  it('Toast: show + auto dismiss; useToast is a no-op outside provider', () => {
    vi.useFakeTimers();
    const Trigger = () => {
      const t = useToast();
      return (
        <button onClick={() => t.show('已保存', { tone: 'success', duration: 1000 })}>go</button>
      );
    };
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText('go'));
    expect(screen.getByRole('status').textContent).toContain('已保存');
    act(() => void vi.advanceTimersByTime(1100));
    expect(screen.queryByRole('status')).toBeNull();
    vi.useRealTimers();
    cleanup();
    render(<Trigger />);
    expect(() => fireEvent.click(screen.getByText('go'))).not.toThrow();
  });
});

describe('Modal close button + title bar offset', () => {
  const Drawer: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <ModalHostContext.Provider value={{ mode: 'drawer' }}>
      <Modal open onClose={onClose} title="T" data-testid="m">
        body
      </Modal>
    </ModalHostContext.Provider>
  );

  it('close is a compact text button「关闭」(no icon), keeps aria-label; en shows Close', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Drawer onClose={onClose} />);
    const btn = screen.getByRole('button', { name: '关闭' });
    expect(btn.textContent).toBe('关闭');
    expect(btn.getAttribute('aria-label')).toBe('关闭');
    expect(btn.querySelector('svg')).toBeNull();
    expect(btn.className).toContain('cd-modal__close');
    expect(btn.className).not.toContain('cd-icon-btn');
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('m-overlay'));
    expect(onClose).toHaveBeenCalledTimes(3);
    act(() => applyLocale('en'));
    try {
      rerender(<Drawer onClose={onClose} />);
      const en = screen.getByRole('button', { name: 'Close' });
      expect(en.textContent).toBe('Close');
    } finally {
      act(() => applyLocale('zh-CN'));
    }
  });

  it('overlay (drawer and dialog) starts below the title bar and is not a drag region', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/base.css'), 'utf8');
    const rule = (sel: string) => {
      const i = css.indexOf(`${sel} {`);
      return css.slice(i, css.indexOf('}', i));
    };
    expect(rule('.cd-modal-overlay')).toMatch(/inset:\s*var\(--cd-titlebar-h, 0px\) 0 0 0/);
    expect(rule('.cd-modal-overlay--drawer')).not.toMatch(/app-region|inset|top:/);
  });
});
