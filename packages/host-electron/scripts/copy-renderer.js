const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const copydir = require('fs-extra').copy;

// 路径设置
const srcDir = path.join(__dirname, '../../renderer/dist');
const destDir = path.join(__dirname, '../dist/renderer');
// AI 对话窗口（@nomi-ai/ai-chat）构建产物：WindowManager 在未打包的生产模式下从 dist/ai-chat 加载
const aiChatSrcDir = path.join(__dirname, '../../ai-chat/dist');
const aiChatDestDir = path.join(__dirname, '../dist/ai-chat');

// 确保目标目录存在
if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

async function copyRenderer() {
  try {
    // 检查源目录是否存在
    if (!fs.existsSync(srcDir)) {
      console.error(`错误: 渲染器构建产物目录不存在 (${srcDir})`);
      console.error('请先运行 "pnpm run build" 在 renderer 包中');
      process.exit(1);
    }

    // 复制目录
    await copydir(srcDir, destDir);
    console.log(`✅ 已复制渲染器构建产物到 ${destDir}`);

    // tts-config.html 由 renderer 的 vite 多页面构建输出到 dist/，已随上面一起复制

    // 复制 AI 对话窗口构建产物
    if (fs.existsSync(path.join(aiChatSrcDir, 'index.html'))) {
      await copydir(aiChatSrcDir, aiChatDestDir);
      console.log(`✅ 已复制 AI 对话窗口构建产物到 ${aiChatDestDir}`);
    } else {
      console.warn(`⚠️  AI 对话窗口构建产物不存在: ${aiChatSrcDir}（请先构建 @nomi-ai/ai-chat）`);
    }
  } catch (err) {
    console.error('复制渲染器构建产物时出错:', err);
    process.exit(1);
  }
}

copyRenderer();
