package igtools

// tools.ts 的补充文件工具：fs_edit / fs_mkdir / fs_move / fs_copy，以及新建时补建上级文件夹、授权提示

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/bundleigbase/tools"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/ai/runtime/aifacade"
	"github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/core/desktop"
	u "github.com/Cookieboty/nomi-ai/apps/desktop-go/internal/gateway/util"
)

const (
	maxNewDirs   = 16
	maxEditBytes = 2 * 1024 * 1024
)

var (
	editIn = aifacade.ObjOf('S', "path", pathS(),
		"edits", func() z {
			a := aifacade.Arr(aifacade.ObjOf('S', "oldText", str(1, 100_000), "newText", str(0, 100_000),
				"replaceAll", aifacade.Default(aifacade.Bool, func() any { return false })))
			a.Min, a.Max = 1, 50
			return a
		}(),
		"dryRun", aifacade.Default(aifacade.Bool, func() any { return false }))
	mkdirIn = aifacade.ObjOf('S', "path", pathS(), "dryRun", aifacade.Default(aifacade.Bool, func() any { return false }))
	moveIn  = aifacade.ObjOf('S', "from", pathS(), "to", pathS(), "dryRun", aifacade.Default(aifacade.Bool, func() any { return false }))
)

// scopeHint：没有授权时告诉模型怎么办
func scopeHint(code, need string) string {
	switch code {
	case "outside_scope":
		rw := ""
		if need == "write" {
			rw = "，mode 用 read-write"
		}
		return "（需要访问这个位置时，先用 desktop_request_scope 请用户授权它所在的文件夹" + rw + "）"
	case "read_only":
		return "（需要写入时，用 desktop_request_scope 请用户把这个文件夹授权为 read-write）"
	}
	return ""
}

func toolCode(err error) string {
	var te *desktop.ToolError
	if errors.As(err, &te) {
		return te.Code
	}
	return ""
}

// target = guardTarget 的结果：目标守卫（上级缺失时为规划出的真实路径）+ 要补建的文件夹
type target struct {
	g       guarded
	newDirs []string // 真实路径
	plan    []string // 原始写法（自上而下）
}

// missingParents：自下而上找到第一个已存在的祖先；返回要补建的文件夹（自上而下）与第一级的守卫结果
func (k *deskKit) missingParents(p, ws string) ([]string, *guarded, error) {
	var dirs []string
	cur := filepath.Dir(filepath.Clean(p))
	for {
		if len(dirs) >= maxNewDirs {
			return nil, nil, toolErr("too_deep", "一次最多新建 "+strconv.Itoa(maxNewDirs)+" 层文件夹")
		}
		g, err := k.guard(cur, "write", true, ws)
		if err == nil {
			if g.Exists {
				st, err := os.Stat(g.Real)
				if err != nil {
					return nil, nil, nodeFSErr(err, "stat", g.Real)
				}
				if !st.IsDir() {
					return nil, nil, toolErr("not_directory", "「"+basename(g.Real)+"」不是文件夹")
				}
				return reverse(dirs), nil, nil
			}
			dirs = append(dirs, cur)
			return reverse(dirs), &g, nil
		}
		if toolCode(err) != "not_found" {
			return nil, nil, err
		}
		up := filepath.Dir(cur)
		if up == cur {
			return nil, nil, err
		}
		dirs = append(dirs, cur)
		cur = up
	}
}

func reverse(s []string) []string {
	for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
		s[i], s[j] = s[j], s[i]
	}
	return s
}

// guardTarget：写入目标的守卫；上级文件夹不存在时也放行（只做规划），建文件夹在确认之后（makeDirs）
func (k *deskKit) guardTarget(p, ws string) (target, error) {
	g, err := k.guard(p, "write", true, ws)
	if err == nil {
		return target{g: g}, nil
	}
	if toolCode(err) != "not_found" {
		return target{}, err
	}
	dirs, top, merr := k.missingParents(p, ws)
	if merr != nil {
		return target{}, merr
	}
	if top == nil {
		return target{}, err
	}
	base := filepath.Dir(top.Real)
	from := filepath.Dir(filepath.Clean(dirs[0]))
	rel, _ := filepath.Rel(from, filepath.Clean(p))
	t := target{g: *top, plan: dirs}
	t.g.Real = filepath.Join(base, rel)
	t.g.Exists = false
	for _, d := range dirs {
		r, _ := filepath.Rel(from, d)
		t.newDirs = append(t.newDirs, filepath.Join(base, r))
	}
	return t, nil
}

// makeDirs：按规划逐级建文件夹（每一级重新守卫）；返回实际新建的真实路径
func (k *deskKit) makeDirs(plan []string, ws string) ([]string, error) {
	made := []string{}
	for _, d := range plan {
		g, err := k.guard(d, "write", true, ws)
		if err != nil {
			return made, err
		}
		if g.Exists {
			continue
		}
		if err := os.Mkdir(g.Real, 0o777); err != nil {
			return made, nodeFSErr(err, "mkdir", g.Real)
		}
		made = append(made, g.Real)
	}
	return made, nil
}

// assertNotRoot：不能动授权根 / 工作区本身或包含它的上级（比较 realpath）
func (k *deskKit) assertNotRoot(real, ws, what string) error {
	var roots []string
	if ws != "" {
		roots = append(roots, ws)
	}
	for _, s := range k.d.Broker.Scopes() {
		roots = append(roots, s.Path)
	}
	for _, root := range roots {
		rootReal := root
		if r, err := filepath.EvalSymlinks(root); err == nil {
			if a, err := filepath.Abs(r); err == nil {
				rootReal = a
			}
		}
		if desktop.IsInside(rootReal, real, k.d.Platform) {
			return toolErr("denied", "不能"+what+"已授权的根文件夹本身")
		}
	}
	return nil
}

func dirsNote(dirs []string) string {
	if len(dirs) == 0 {
		return ""
	}
	return "\n并新建文件夹：" + strings.Join(dirs, "、")
}

func (k *deskKit) extraFsTools() []tools.Definition {
	wrap := func(name string, s z, b func(ctx context.Context, i *u.Obj, ec tools.ExecContext) (any, string, error)) tools.Definition {
		return deskDef(name, "", func(ctx context.Context, in any, ec tools.ExecContext) (any, error) {
			i, err := parse(s, in)
			if err != nil {
				return nil, err
			}
			return k.run(name, i, func() (any, string, error) { return b(ctx, i, ec) }), nil
		})
	}
	return []tools.Definition{
		wrap("fs_edit", editIn, k.edit),
		wrap("fs_mkdir", mkdirIn, k.mkdir),
		wrap("fs_move", moveIn, k.move),
		wrap("fs_copy", moveIn, k.copy),
	}
}

func clip300(s string) string {
	if u.UTF16Len(s) > 300 {
		return u.UTF16Slice0(s, 300) + "…"
	}
	return s
}

const editConflict = "文件在等待确认期间被其他程序改过（例如在编辑器里保存了），这次修改没有写入，文件保持对方保存的版本；先用 fs_read_text 重新读取最新内容再改"

// editBeforeTrash 只给测试用：模拟「重读比对之后、移入回收站之前」的外部写入
var editBeforeTrash func(path string)

// commitEditSource 是 fs_edit 的提交前版本核对（同 tools.ts 的 commitEditSource）：
// 确认可能等很久，期间用户可能在编辑器里保存了同一文件。
//  1. 重读比对内容哈希，与确认前读到的不同就报 conflict，什么都不动；
//  2. 把文件移入应用回收站（同盘 rename，原子），再核对被移走的正是比对过的版本——
//     这样「重读之后、移走之前」的窗口也被覆盖：不一致就原样放回并报 conflict。
//
// 剩余窗口只有：移走之后仍持有旧文件句柄原地写入的程序，其写入落在回收站里的旧版本上
// （撤销可取回）；移走之后有人在原路径新建文件则由写回的 O_EXCL 拒绝（见调用处）。
func (k *deskKit) commitEditSource(real string, expected [32]byte) (desktop.TrashRecord, error) {
	cur, err := os.ReadFile(real)
	if err != nil || sha256.Sum256(cur) != expected {
		return desktop.TrashRecord{}, toolErr("conflict", editConflict)
	}
	if editBeforeTrash != nil {
		editBeforeTrash(real)
	}
	rec, err := k.d.Trash.Trash(real)
	if err != nil {
		return rec, err
	}
	if moved, err := os.ReadFile(rec.Stored); err == nil && sha256.Sum256(moved) == expected {
		return rec, nil
	}
	// 放回失败（原路径已被新建）时较新的那份留在原处，被移走的留在应用回收站，都不丢
	_ = k.d.Trash.Restore(rec.Stored, rec.Original)
	return desktop.TrashRecord{}, toolErr("conflict", editConflict)
}

func (k *deskKit) edit(ctx context.Context, i *u.Obj, ec tools.ExecContext) (any, string, error) {
	ws := k.d.Broker.WorkspaceOf(k.cwd(ec))
	g, err := k.guard(i.Get("path"), "write", false, ws)
	if err != nil {
		return nil, "", err
	}
	st, err := os.Stat(g.Real)
	if err != nil {
		return nil, "", nodeFSErr(err, "stat", g.Real)
	}
	if !st.Mode().IsRegular() {
		return nil, "", toolErr("not_file", "不是文件")
	}
	if st.Size() > maxEditBytes {
		return nil, "", toolErr("too_large", "文件超过 2MB，不能用 fs_edit 修改")
	}
	buf, err := os.ReadFile(g.Real)
	if err != nil {
		return nil, "", nodeFSErr(err, "open", g.Real)
	}
	if bytes.IndexByte(buf, 0) >= 0 || !utf8.Valid(buf) {
		return nil, "", toolErr("unsupported", "不是 UTF-8 文本文件，不能用 fs_edit 修改")
	}
	text := string(buf)
	edits, _ := i.Get("edits").([]any)
	replacements := 0
	var lines []string
	for n, raw := range edits {
		e := raw.(*u.Obj)
		oldT, newT := str0(e, "oldText"), str0(e, "newText")
		all := e.Get("replaceAll") == true
		count := strings.Count(text, oldT)
		if count == 0 {
			return nil, "", toolErr("no_match", fmt.Sprintf("第 %d 处：文件里找不到 oldText（要逐字一致，含空白与换行；先用 fs_read_text 看原文）", n+1))
		}
		if count > 1 && !all {
			return nil, "", toolErr("ambiguous", fmt.Sprintf("第 %d 处：oldText 出现了 %d 次；多带一些上下文让它唯一，或者设 replaceAll", n+1, count))
		}
		if all {
			text = strings.ReplaceAll(text, oldT, newT)
			replacements += count
		} else {
			text = strings.Replace(text, oldT, newT, 1)
			replacements++
		}
		lines = append(lines, "- "+clip300(oldT)+"\n+ "+clip300(newT))
	}
	preview := fmt.Sprintf("修改 %s\n%d 处，共替换 %d 次：\n\n", g.Real, len(edits), replacements) + strings.Join(lines, "\n\n")
	if i.Get("dryRun") == true {
		return u.NewObj("dryRun", true, "plan", preview), "", nil
	}
	dec, err := k.confirm(ctx, "fs_edit", "修改「"+basename(g.Real)+"」？",
		u.NewObj("path", g.Real, "edits", float64(len(edits)), "replacements", float64(replacements)), strp(preview), nil, wsFor(ws, g))
	if err != nil {
		return nil, "", err
	}
	rec, err := k.commitEditSource(g.Real, sha256.Sum256(buf))
	if err != nil {
		return nil, "", err
	}
	if err := writeExcl(g.Real, text); err != nil {
		// 移走之后、写回之前有人在原路径新建了文件：保留对方的文件，旧版本留在应用回收站
		if _, serr := os.Lstat(g.Real); serr == nil {
			return nil, "", toolErr("conflict", editConflict)
		}
		return nil, "", err
	}
	_ = os.Chmod(g.Real, st.Mode().Perm())
	w, err := os.Stat(g.Real)
	if err != nil {
		return nil, "", nodeFSErr(err, "stat", g.Real)
	}
	es, em := float64(w.Size()), mtimeMs(w)
	e := k.d.Journal.Record("fs_edit", "edit "+basename(g.Real), []desktop.InverseOp{
		{Op: "trash", Path: g.Real, ExpectSize: &es, ExpectMtimeMs: &em},
		{Op: "restore", Stored: rec.Stored, Original: rec.Original},
	})
	return u.NewObj("path", g.Real, "replacements", float64(replacements), "undoId", e.ID), dec, nil
}

func (k *deskKit) mkdir(ctx context.Context, i *u.Obj, ec tools.ExecContext) (any, string, error) {
	ws := k.d.Broker.WorkspaceOf(k.cwd(ec))
	p := str0(i, "path")
	t, err := k.guardTarget(p, ws)
	if err != nil {
		return nil, "", err
	}
	if t.g.Exists {
		st, err := os.Stat(t.g.Real)
		if err != nil {
			return nil, "", nodeFSErr(err, "stat", t.g.Real)
		}
		if !st.IsDir() {
			return nil, "", toolErr("exists", "同名文件已存在")
		}
		return u.NewObj("path", t.g.Real, "created", []any{}), "", nil
	}
	preview := "新建文件夹：" + strings.Join(append(append([]string{}, t.newDirs...), t.g.Real), "、")
	if i.Get("dryRun") == true {
		return u.NewObj("dryRun", true, "plan", preview), "", nil
	}
	dec, err := k.confirm(ctx, "fs_mkdir", "新建文件夹「"+basename(t.g.Real)+"」？", u.NewObj("path", t.g.Real), strp(preview), nil, wsFor(ws, t.g))
	if err != nil {
		return nil, "", err
	}
	made, err := k.makeDirs(append(append([]string{}, t.plan...), p), ws)
	if err != nil {
		return nil, "", err
	}
	if len(made) == 0 {
		return u.NewObj("path", t.g.Real, "created", []any{}), dec, nil
	}
	created := make([]any, len(made))
	for j, m := range made {
		created[j] = m
	}
	// 撤销：把最上层新建的文件夹移到回收站
	e := k.d.Journal.Record("fs_mkdir", "mkdir "+basename(t.g.Real), []desktop.InverseOp{{Op: "trash", Path: made[0]}})
	return u.NewObj("path", t.g.Real, "created", created, "undoId", e.ID), dec, nil
}

// dest：补建上级文件夹后重新守卫目标
func (k *deskKit) dest(t target, p, ws string) (guarded, error) {
	if _, err := k.makeDirs(t.plan, ws); err != nil {
		return guarded{}, err
	}
	dst := t.g
	if len(t.newDirs) > 0 {
		g, err := k.guard(p, "write", true, ws)
		if err != nil {
			return guarded{}, err
		}
		dst = g
	}
	if dst.Exists {
		return guarded{}, toolErr("exists", "目标已存在")
	}
	return dst, nil
}

func (k *deskKit) move(ctx context.Context, i *u.Obj, ec tools.ExecContext) (any, string, error) {
	ws := k.d.Broker.WorkspaceOf(k.cwd(ec))
	src, err := k.guard(i.Get("from"), "write", false, ws)
	if err != nil {
		return nil, "", err
	}
	if err := k.assertNotRoot(src.Real, ws, "移动"); err != nil {
		return nil, "", err
	}
	to := str0(i, "to")
	t, err := k.guardTarget(to, ws)
	if err != nil {
		return nil, "", err
	}
	if t.g.Exists {
		return nil, "", toolErr("exists", "目标已存在")
	}
	if desktop.IsInside(t.g.Real, src.Real, k.d.Platform) {
		return nil, "", toolErr("invalid", "不能把文件夹移到它自己里面")
	}
	preview := "移动：" + src.Real + "\n到：" + t.g.Real + dirsNote(t.newDirs)
	if i.Get("dryRun") == true {
		return u.NewObj("dryRun", true, "plan", preview), "", nil
	}
	cws := ""
	if src.inWorkspace && t.g.inWorkspace {
		cws = ws
	}
	dec, err := k.confirm(ctx, "fs_move", "移动「"+basename(src.Real)+"」到「"+basename(t.g.Real)+"」？",
		u.NewObj("from", src.Real, "to", t.g.Real), strp(preview), nil, cws)
	if err != nil {
		return nil, "", err
	}
	dst, err := k.dest(t, to, ws)
	if err != nil {
		return nil, "", err
	}
	if err := desktop.MoveNoOverwrite(src.Real, dst.Real); err != nil {
		return nil, "", err
	}
	e := k.d.Journal.Record("fs_move", "move "+basename(src.Real)+" → "+basename(dst.Real),
		[]desktop.InverseOp{{Op: "move", From: dst.Real, To: src.Real}})
	return u.NewObj("from", src.Real, "to", dst.Real, "undoId", e.ID), dec, nil
}

func (k *deskKit) copy(ctx context.Context, i *u.Obj, ec tools.ExecContext) (any, string, error) {
	ws := k.d.Broker.WorkspaceOf(k.cwd(ec))
	src, err := k.guard(i.Get("from"), "read", false, ws)
	if err != nil {
		return nil, "", err
	}
	st, err := os.Stat(src.Real)
	if err != nil {
		return nil, "", nodeFSErr(err, "stat", src.Real)
	}
	if !st.Mode().IsRegular() {
		return nil, "", toolErr("not_file", "只能复制文件；文件夹请先 fs_mkdir 再逐个 fs_copy")
	}
	to := str0(i, "to")
	t, err := k.guardTarget(to, ws)
	if err != nil {
		return nil, "", err
	}
	if t.g.Exists {
		return nil, "", toolErr("exists", "目标已存在")
	}
	preview := "复制：" + src.Real + "\n到：" + t.g.Real + dirsNote(t.newDirs) + "\n" + strconv.FormatInt(st.Size(), 10) + " 字节"
	if i.Get("dryRun") == true {
		return u.NewObj("dryRun", true, "plan", preview), "", nil
	}
	dec, err := k.confirm(ctx, "fs_copy", "复制「"+basename(src.Real)+"」到「"+basename(t.g.Real)+"」？",
		u.NewObj("from", src.Real, "to", t.g.Real), strp(preview), nil, wsFor(ws, t.g))
	if err != nil {
		return nil, "", err
	}
	dst, err := k.dest(t, to, ws)
	if err != nil {
		return nil, "", err
	}
	if err := copyExcl(src.Real, dst.Real, st.Mode().Perm()); err != nil {
		return nil, "", err
	}
	w, err := os.Stat(dst.Real)
	if err != nil {
		return nil, "", nodeFSErr(err, "stat", dst.Real)
	}
	es, em := float64(w.Size()), mtimeMs(w)
	e := k.d.Journal.Record("fs_copy", "copy "+basename(dst.Real),
		[]desktop.InverseOp{{Op: "trash", Path: dst.Real, ExpectSize: &es, ExpectMtimeMs: &em}})
	return u.NewObj("from", src.Real, "to", dst.Real, "undoId", e.ID), dec, nil
}

// copyFile(src, dst, COPYFILE_EXCL)：目标权限同源文件
func copyExcl(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return nodeFSErr(err, "copyfile", src)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, perm)
	if err != nil {
		return nodeFSErr(err, "copyfile", dst)
	}
	_, cerr := io.Copy(out, in)
	if err := out.Close(); cerr == nil {
		cerr = err
	}
	if cerr != nil {
		_ = os.Remove(dst)
		return cerr
	}
	return os.Chmod(dst, perm)
}
