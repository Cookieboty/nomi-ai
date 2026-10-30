// 用法：node scripts/smoke-silero.cjs <silero_vad.onnx>（需先 build）。验证主进程 CJS 产物能加载 onnxruntime-web 并推理。
const { SileroStream } = require('../dist/voice/sileroNode.js');
(async () => {
  const v = new SileroStream(process.argv[2]);
  let silent = 0;
  for (let i = 0; i < 5; i++) silent = await v.prob(new Float32Array(512));
  console.log('silence prob', silent.toFixed(3));
  if (!(silent < 0.2)) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
