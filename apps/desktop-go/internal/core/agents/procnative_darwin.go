//go:build darwin && cgo

package agents

/*
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <mach/mach_time.h>
#include <stdlib.h>
#include <string.h>

// 一个进程的父进程、常驻内存、累计 CPU（纳秒）、可执行文件路径；读不到的字段留 0 / 空。
// 返回 0 = 至少拿到了父进程（进程还在）。
static int nomi_proc_info(int pid, int *ppid, unsigned long long *rss, unsigned long long *cpuNs,
                          char *path, int pathLen, char *name, int nameLen) {
	struct proc_bsdshortinfo sb;
	*ppid = 0; *rss = 0; *cpuNs = 0; path[0] = 0; name[0] = 0;
	if (proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 1, &sb, sizeof(sb)) != sizeof(sb)) return -1;
	*ppid = (int)sb.pbsi_ppid;
	strlcpy(name, sb.pbsi_comm, nameLen);
	struct proc_taskinfo ti;
	if (proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &ti, sizeof(ti)) == sizeof(ti)) {
		static mach_timebase_info_data_t tb;
		if (tb.denom == 0) mach_timebase_info(&tb);
		*rss = ti.pti_resident_size;
		// pti_total_* 是 mach 时钟数（Apple 芯片上不是纳秒），按时基换算
		*cpuNs = (ti.pti_total_user + ti.pti_total_system) * tb.numer / tb.denom;
	}
	if (proc_pidpath(pid, path, pathLen) <= 0) path[0] = 0;
	return 0;
}

// 命令行（KERN_PROCARGS2：argc + 可执行路径 + 若干 \0 + argv[0..argc)），参数之间用空格接起来。
// 返回写入的字节数；读不到（别的用户的进程等）返回 -1。
static int nomi_proc_args(int pid, char *out, int outLen) {
	int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
	static int argmax = 0;
	if (argmax == 0) {
		int m[2] = {CTL_KERN, KERN_ARGMAX};
		size_t sz = sizeof(argmax);
		if (sysctl(m, 2, &argmax, &sz, NULL, 0) != 0 || argmax <= 0) argmax = 1 << 18;
	}
	char *buf = malloc(argmax);
	if (!buf) return -1;
	size_t size = argmax;
	if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) { free(buf); return -1; }
	int argc; memcpy(&argc, buf, sizeof(int));
	char *p = buf + sizeof(int), *end = buf + size;
	while (p < end && *p) p++;          // 可执行文件路径
	while (p < end && !*p) p++;         // 填充的 \0
	int n = 0;
	for (int i = 0; i < argc && p < end; i++) {
		size_t l = strnlen(p, end - p);
		if (n > 0 && n < outLen - 1) out[n++] = ' ';
		size_t c = l < (size_t)(outLen - 1 - n) ? l : (size_t)(outLen - 1 - n);
		memcpy(out + n, p, c); n += (int)c;
		p += l + 1;
	}
	out[n] = 0;
	free(buf);
	return n;
}
*/
import "C"

import (
	"path/filepath"
	"unsafe"
)

// readProcessesNative：用 libproc / sysctl 直接读进程表（不起 ps 子进程）；nil = 读不到，调用方退回 ps。
// 字段与 ps 的 pid / ppid / rss / time / comm / args 对应：Name = 可执行文件名（读不到路径时用内核记的短名），
// Cmd = 完整命令行（读不到参数时用可执行文件路径，再不行用 Name）。
func readProcessesNative() []RawProc {
	n := C.proc_listallpids(nil, 0)
	if n <= 0 {
		return nil
	}
	pids := make([]C.int, int(n)+64)
	n = C.proc_listallpids(unsafe.Pointer(&pids[0]), C.int(len(pids))*C.int(unsafe.Sizeof(pids[0])))
	if n <= 0 {
		return nil
	}
	const pathLen, nameLen, argsLen = 4096, 64, 8192
	path := (*C.char)(C.malloc(pathLen))
	name := (*C.char)(C.malloc(nameLen))
	args := (*C.char)(C.malloc(argsLen))
	defer C.free(unsafe.Pointer(path))
	defer C.free(unsafe.Pointer(name))
	defer C.free(unsafe.Pointer(args))
	out := make([]RawProc, 0, int(n))
	for _, pid := range pids[:int(n)] {
		if pid <= 0 {
			continue
		}
		var ppid C.int
		var rss, cpuNs C.ulonglong
		if C.nomi_proc_info(pid, &ppid, &rss, &cpuNs, path, pathLen, name, nameLen) != 0 {
			continue // 进程刚退出
		}
		p := RawProc{Pid: float64(pid), Ppid: float64(ppid), RSS: float64(rss), CPU: float64(cpuNs) / 1e9}
		exe := C.GoString(path)
		if exe != "" {
			p.Name = filepath.Base(exe)
		} else {
			p.Name = C.GoString(name)
		}
		switch {
		case C.nomi_proc_args(pid, args, argsLen) > 0:
			p.Cmd = C.GoString(args)
		case exe != "": // 别的用户的进程读不到参数：同 ps，至少给出可执行文件路径
			p.Cmd = exe
		default:
			p.Cmd = p.Name
		}
		out = append(out, p)
	}
	return out
}
