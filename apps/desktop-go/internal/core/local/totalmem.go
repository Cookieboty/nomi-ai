package local

// TotalMem：本机物理内存（字节；读不到为 0）
func TotalMem() uint64 { return totalMem() }
