/* global AudioWorkletProcessor, registerProcessor -- AudioWorklet 全局作用域 */
// AudioWorklet：在音频线程里收集麦克风样本，攒满一块再发给主线程。
// 主线程忙（例如桌面角色 3D 渲染）时消息只会排队，不会像 ScriptProcessor 那样丢帧。
const BLOCK = 2048;

class CdCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, BLOCK - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === BLOCK) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(BLOCK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('cd-capture', CdCapture);
