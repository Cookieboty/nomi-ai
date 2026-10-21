// 全局 setup 把 fs / path 换成了 mock；这里需要真实文件系统
jest.unmock('fs');
jest.unmock('path');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AppTrash } from '../../../src/desktop/AppTrash';
import { AuditLog, redactArgs } from '../../../src/desktop/AuditLog';
import { UndoJournal } from '../../../src/desktop/UndoJournal';

describe('undo journal + app trash', () => {
  let root: string;
  let trash: AppTrash;
  let journal: UndoJournal;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
    fs.mkdirSync(path.join(root, 'docs'));
    trash = new AppTrash(path.join(root, 'trash'));
    journal = new UndoJournal(path.join(root, 'journal.jsonl'), trash);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('trash never deletes: file moves into the app trash and undo restores it', async () => {
    const f = path.join(root, 'docs', 'a.txt');
    fs.writeFileSync(f, 'hello');
    const rec = await trash.trash(f);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.readFileSync(rec.stored, 'utf8')).toBe('hello');
    journal.record('fs_trash', 'trash a.txt', [{ op: 'restore', stored: rec.stored, original: f }]);
    const last = journal.last()!;
    expect(last.summary).toBe('trash a.txt');
    await journal.undo(last);
    expect(fs.readFileSync(f, 'utf8')).toBe('hello');
    expect(journal.last()).toBeNull();
    expect(journal.list()[0].undone).toBe(true);
  });

  it('undo of a created file moves it to trash; undo of append truncates back', async () => {
    const f = path.join(root, 'docs', 'n.txt');
    fs.writeFileSync(f, 'abc');
    journal.record('fs_write_text', 'create n.txt', [{ op: 'trash', path: f }]);
    await journal.undo(journal.last()!);
    expect(fs.existsSync(f)).toBe(false);

    const g = path.join(root, 'docs', 'g.txt');
    fs.writeFileSync(g, 'one');
    fs.appendFileSync(g, 'two');
    journal.record('fs_write_text', 'append g.txt', [
      { op: 'truncate', path: g, size: 3, expectSize: 6 },
    ]);
    await journal.undo(journal.last()!);
    expect(fs.readFileSync(g, 'utf8')).toBe('one');
  });

  it('refuses to undo when the file changed afterwards or the target is occupied', async () => {
    const g = path.join(root, 'docs', 'g.txt');
    fs.writeFileSync(g, 'onetwo-and-more');
    journal.record('fs_write_text', 'append g.txt', [
      { op: 'truncate', path: g, size: 3, expectSize: 6 },
    ]);
    expect(journal.check(journal.last()!)).toMatch(/修改/);
    await expect(journal.undo(journal.last()!)).rejects.toMatchObject({ code: 'conflict' });

    const f = path.join(root, 'docs', 'a.txt');
    fs.writeFileSync(f, 'x');
    const rec = await trash.trash(f);
    fs.writeFileSync(f, 'new one');
    journal.record('fs_trash', 'trash a.txt', [{ op: 'restore', stored: rec.stored, original: f }]);
    await expect(journal.undo(journal.last()!)).rejects.toMatchObject({ code: 'conflict' });
    expect(fs.readFileSync(f, 'utf8')).toBe('new one');
  });

  it('overwrite inverse [trash new, restore old] pre-checks sequentially (#27)', async () => {
    const f = path.join(root, 'docs', 'o.txt');
    fs.writeFileSync(f, 'old');
    const rec = await trash.trash(f);
    fs.writeFileSync(f, 'new!');
    const st = fs.statSync(f);
    journal.record('fs_write_text', 'overwrite o.txt', [
      { op: 'trash', path: f, expectSize: st.size, expectMtimeMs: st.mtimeMs },
      { op: 'restore', stored: rec.stored, original: f },
    ]);
    expect(journal.check(journal.last()!)).toBeNull();
    await journal.undo(journal.last()!);
    expect(fs.readFileSync(f, 'utf8')).toBe('old');
    expect(journal.last()).toBeNull();
  });

  it('a restore whose original is occupied with no preceding trash still conflicts (#27)', async () => {
    const f = path.join(root, 'docs', 'p.txt');
    fs.writeFileSync(f, 'old');
    const rec = await trash.trash(f);
    fs.writeFileSync(f, 'user file');
    journal.record('x', 'restore only', [{ op: 'restore', stored: rec.stored, original: f }]);
    expect(journal.check(journal.last()!)).toMatch(/无法恢复/);
  });

  it('overwrite undo is refused when the new file changed; copies stay intact (#27)', async () => {
    const f = path.join(root, 'docs', 'q.txt');
    fs.writeFileSync(f, 'old');
    const rec = await trash.trash(f);
    fs.writeFileSync(f, 'new!');
    const st = fs.statSync(f);
    journal.record('fs_write_text', 'overwrite q.txt', [
      { op: 'trash', path: f, expectSize: st.size, expectMtimeMs: st.mtimeMs },
      { op: 'restore', stored: rec.stored, original: f },
    ]);
    fs.writeFileSync(f, 'edited by user after');
    await expect(journal.undo(journal.last()!)).rejects.toMatchObject({ code: 'conflict' });
    expect(fs.readFileSync(f, 'utf8')).toBe('edited by user after');
    expect(fs.readFileSync(rec.stored, 'utf8')).toBe('old');
  });

  it('rolls back executed steps when a later step fails (#27)', async () => {
    const f = path.join(root, 'docs', 'r.txt');
    fs.writeFileSync(f, 'old');
    const rec = await trash.trash(f);
    fs.writeFileSync(f, 'new!');
    const st = fs.statSync(f);
    journal.record('fs_write_text', 'overwrite r.txt', [
      { op: 'trash', path: f, expectSize: st.size, expectMtimeMs: st.mtimeMs },
      { op: 'restore', stored: rec.stored, original: f },
    ]);
    // 检查通过之后、执行之前让恢复失败：回收站里旧副本被清掉的同时 check 之后才发生
    const realRestore = trash.restore.bind(trash);
    let calls = 0;
    jest.spyOn(trash, 'restore').mockImplementation(async (r) => {
      calls += 1;
      if (calls === 1) throw new Error('disk error');
      return realRestore(r);
    });
    await expect(journal.undo(journal.last()!)).rejects.toThrow('disk error');
    // 新文件被放回原处，旧副本仍在回收站
    expect(fs.readFileSync(f, 'utf8')).toBe('new!');
    expect(fs.readFileSync(rec.stored, 'utf8')).toBe('old');
    expect(journal.last()).not.toBeNull();
  });

  it('purges trash folders older than 30 days', async () => {
    const old = new AppTrash(path.join(root, 'trash'), () => Date.parse('2020-01-01T00:00:00Z'));
    const f = path.join(root, 'docs', 'o.txt');
    fs.writeFileSync(f, 'o');
    await old.trash(f);
    expect(trash.purge(30)).toBe(1);
  });
});

describe('audit log', () => {
  it('appends JSONL, lists newest first, and never stores text content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    const log = new AuditLog(dir);
    log.append({ tool: 'fs_read_text', args: { path: '/a' }, decision: 'auto', result: 'ok' });
    log.append({
      tool: 'fs_write_text',
      args: { path: '/b', text: 'TOP SECRET' },
      decision: 'allowed',
      result: 'ok',
    });
    const list = log.list();
    expect(list.map((e) => e.tool)).toEqual(['fs_write_text', 'fs_read_text']);
    expect(JSON.stringify(list)).not.toContain('TOP SECRET');
    expect(list[0].args.text).toMatchObject({ length: 10 });
    log.clear();
    expect(log.list()).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('redactArgs truncates long strings and drops objects', () => {
    expect(redactArgs({ path: 'x'.repeat(400), nested: { a: 1 }, n: 3 })).toMatchObject({
      n: 3,
      nested: '[object]',
    });
  });
});
