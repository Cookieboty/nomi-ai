// 工具子进程的测试脚本：经 process.parentPort 收消息、原样回一份（带上 argv 与 Uint8Array）
const port = process.parentPort;
port.on('message', ({ data }) => {
  if (data === 'exit') process.exit(3);
  port.postMessage({ echo: data, argv: process.argv.slice(1), bytes: new Uint8Array([1, 2]) });
});
