'use strict';

/**
 * e2e-headed preload
 *
 * 1. 暴露 `window.nomiTransport`（契约传输）与 `window.aiIPC`（其余 `ai:*` 通道），与真实 preload 一致；
 * 2. preload 自己建一个契约客户端，订阅全部 AI 事件写进采集器；
 * 3. 挂 `window.__e2eProbe`：Playwright 从这里拿事件，也可以 `call(过程名, 入参)` 调内核。
 */

const { contextBridge, ipcRenderer } = require('electron');
const { mkAiPreload, mkNomiTransportPreload } = require('@nomi-ai/ai-sdk-client/preload');
const { createClient, createIpcClientTransport } = require('@nomi-ai/contract');
const { AI_EVENTS, appContract } = require('@nomi-ai/contract/app');

mkNomiTransportPreload({ contextBridge, ipcRenderer });
mkAiPreload({ contextBridge, ipcRenderer });

const api = createClient(
  appContract,
  createIpcClientTransport({
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
    on(channel, fn) {
      const listener = (_event, payload) => fn(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  }),
);

const buffer = {
  ttsChunks: [],
  turnEnds: [],
  toolExecuted: [],
  profileChanged: [],
  events: [],
};

const record = (evt, data) => {
  buffer.events.push({ evt, data });
  if (evt === 'tts:chunk') buffer.ttsChunks.push(data);
  else if (evt === 'agent:turn-end') buffer.turnEnds.push(data);
  else if (evt === 'tool:executed') buffer.toolExecuted.push(data);
  else if (evt === 'userProfile:changed') buffer.profileChanged.push(data);
};
for (const [evt, event] of Object.entries(AI_EVENTS)) {
  api.on(event, (data) => record(evt, data));
}

/** `ai.tools.list` → api.ai.tools.list */
const procedure = (name) => name.split('.').reduce((node, seg) => node && node[seg], api);

contextBridge.exposeInMainWorld('__e2eProbe', {
  /** 经契约调用一个 query / mutation 过程 */
  call(name, input) {
    const fn = procedure(name);
    if (typeof fn !== 'function') return Promise.reject(new Error(`unknown procedure ${name}`));
    return fn(input);
  },
  getEvents() {
    return JSON.parse(JSON.stringify(buffer.events));
  },
  getTtsChunks() {
    return JSON.parse(JSON.stringify(buffer.ttsChunks));
  },
  getTurnEnds() {
    return JSON.parse(JSON.stringify(buffer.turnEnds));
  },
  getToolExecuted() {
    return JSON.parse(JSON.stringify(buffer.toolExecuted));
  },
  getProfileChanged() {
    return JSON.parse(JSON.stringify(buffer.profileChanged));
  },
  clear() {
    buffer.ttsChunks.length = 0;
    buffer.turnEnds.length = 0;
    buffer.toolExecuted.length = 0;
    buffer.profileChanged.length = 0;
    buffer.events.length = 0;
  },
});
