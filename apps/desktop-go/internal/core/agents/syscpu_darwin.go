//go:build darwin && cgo

package agents

/*
#include <mach/mach.h>

// 整机累计 CPU 时钟数（所有核加起来）：busy = user + system + nice，total = busy + idle
static int nomi_cpu_load(unsigned long long *busy, unsigned long long *total) {
	host_cpu_load_info_data_t info;
	mach_msg_type_number_t count = HOST_CPU_LOAD_INFO_COUNT;
	mach_port_t host = mach_host_self();
	kern_return_t kr = host_statistics(host, HOST_CPU_LOAD_INFO, (host_info_t)&info, &count);
	mach_port_deallocate(mach_task_self(), host);
	if (kr != KERN_SUCCESS) return -1;
	unsigned long long u = info.cpu_ticks[CPU_STATE_USER];
	unsigned long long s = info.cpu_ticks[CPU_STATE_SYSTEM];
	unsigned long long n = info.cpu_ticks[CPU_STATE_NICE];
	unsigned long long i = info.cpu_ticks[CPU_STATE_IDLE];
	*busy = u + s + n;
	*total = u + s + n + i;
	return 0;
}
*/
import "C"

// SystemCPU：整机累计 CPU 时间（忙 / 总，单位不定，只能两次相减求比例）；ok = false 表示读不到
func SystemCPU() (busy, total float64, ok bool) {
	var b, t C.ulonglong
	if C.nomi_cpu_load(&b, &t) != 0 {
		return 0, 0, false
	}
	return float64(b), float64(t), true
}
