package tools

import (
	"context"
	"sync/atomic"
)

// 工具读出的本地数据（文件正文、命令输出、网页，即带 <file_content> / <command_output> / <web_content> 标记的结果）
// 在工具执行时按当时的接收者检查过（igtools 的 beforeSend）。之后要再交给模型的路径——分页读暂存的长输出
// （aisdk/spill.go）、工具循环里的步骤摘要（aisdk/contextguard.go）——发送前用 CheckDataSend 按这一次的实际
// 接收者重新检查：「仅本地模型可读文件」、首次发给云端的确认和撤销都按此刻的设置算。

// DataSendCheck：recv 非 nil 时检查这个接收者；为 nil 时检查 roles 路由到的模型（如 "summary"）。
// 不允许时返回给模型看的错误
type DataSendCheck func(ctx context.Context, recv *ToolCallProvider, roles ...string) error

var dataSendCheck atomic.Pointer[DataSendCheck]

// SetDataSendCheck：桌面工具装配时注册（igtools.DesktopTools）；nil = 取消
func SetDataSendCheck(f DataSendCheck) {
	if f == nil {
		dataSendCheck.Store(nil)
		return
	}
	dataSendCheck.Store(&f)
}

// CheckDataSend：没有注册检查时放行（没装桌面工具就不会有这类数据）
func CheckDataSend(ctx context.Context, recv *ToolCallProvider, roles ...string) error {
	f := dataSendCheck.Load()
	if f == nil {
		return nil
	}
	return (*f)(ctx, recv, roles...)
}
