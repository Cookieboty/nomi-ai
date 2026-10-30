// CI runners (macOS in particular) can be an order of magnitude slower than a dev machine for
// happy-dom rendering; the default 1s findBy*/waitFor timeout then flakes. Only affects how
// long we are willing to wait for an element that does appear — failures still fail.
import { configure } from '@testing-library/react';

// Windows runner 上再慢几倍（长对话分批补齐窗口要渲染好几轮 Markdown），给到 15 s
configure({ asyncUtilTimeout: process.platform === 'win32' ? 15_000 : 5_000 });
