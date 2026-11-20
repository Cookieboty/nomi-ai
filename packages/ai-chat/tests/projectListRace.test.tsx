// @vitest-environment happy-dom
/**
 * 项目列表首帧快照（`project.list`）与本地增删改、`project.changed` 的竞争：
 * 迟到的旧快照不能把刚移除的项目写回侧栏（否则要删两次才消失），也不能盖掉更新的推送。
 */
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, resetFakeApi, untilIdle } from './helpers/fakeApi';

vi.mock('../src/services/api', async () => (await import('./helpers/fakeApi')).fakeApiModule());

const { __resetProjectsForTest, projectsClient, useProjects } =
  await import('../src/services/projects');

const project = (id: string, name: string) => ({
  id,
  name,
  primary: `/tmp/${name}`,
  folders: [],
  createdAt: 1,
  updatedAt: 1,
});

const A = project('p_a', 'alpha');
const B = project('p_b', 'beta');

/** 挂上一个只读列表的组件：首次订阅触发 start()（发 project.list、订阅 project.changed） */
const Probe: React.FC = () => {
  const projects = useProjects();
  return <div data-testid="ids">{projects.map((p) => p.id).join(',')}</div>;
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const ids = (el: HTMLElement) => el.querySelector('[data-testid="ids"]')?.textContent ?? '';

/** 一个还没返回的 project.list：手动 release 决定它什么时候到 */
function pendingList() {
  let release!: (list: unknown) => void;
  const p = new Promise((r) => {
    release = r;
  });
  return { list: () => p, release };
}

afterEach(() => {
  cleanup();
  resetFakeApi();
});

describe('project list first snapshot', () => {
  it('迟到的旧列表不把刚移除的项目写回（移除一次就消失）', async () => {
    const { list, release } = pendingList();
    installFakeApi({ 'project.list': list, 'project.remove': () => undefined });
    // 本地已经有 A（上一轮同步留下的），这次重新开始拉首帧列表
    __resetProjectsForTest([A]);
    const r = render(<Probe />);
    await tick();
    expect(ids(r.container)).toBe('p_a');

    await projectsClient.remove('p_a');
    expect(ids(r.container)).toBe('');

    release([A]); // 删除期间飞在路上的旧快照
    await tick();
    expect(ids(r.container)).toBe('');
  });

  it('拉列表期间到达的 project.changed 不被迟到的旧快照盖掉', async () => {
    const { list, release } = pendingList();
    const fake = installFakeApi({ 'project.list': list });
    __resetProjectsForTest();
    const r = render(<Probe />);
    await tick();

    await fake.emit('project.changed', [B]); // 请求还在路上，内核推了更新的列表
    expect(ids(r.container)).toBe('p_b');

    release([A]); // 迟到的旧快照
    await tick();
    expect(ids(r.container)).toBe('p_b');
  });

  it('新建的项目不被迟到的旧列表冲掉', async () => {
    const { list, release } = pendingList();
    installFakeApi({ 'project.list': list, 'project.create': () => A });
    __resetProjectsForTest();
    const r = render(<Probe />);
    await tick();

    await projectsClient.create({ name: 'alpha', primary: '/tmp/alpha' });
    expect(ids(r.container)).toBe('p_a');

    release([]); // 新建之前发出的空快照
    await tick();
    expect(ids(r.container)).toBe('p_a');
  });

  it('没被打断时首帧列表照常落地', async () => {
    installFakeApi({ 'project.list': () => [A, B] });
    __resetProjectsForTest();
    const r = render(<Probe />);
    await untilIdle();
    expect(ids(r.container)).toBe('p_a,p_b');
  });
});
