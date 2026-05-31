<div align="center">

<img src="public/icons/icon-128.png" width="96" alt="Chrome 网页表单助手" />

# Chrome 网页表单助手

**AI 网页表单助手：用一句话填完整张表。**

[![Release](https://img.shields.io/github/v/release/your-org/chrome-assistant?style=flat-square)](../../releases)
[![License](https://img.shields.io/github/license/your-org/chrome-assistant?style=flat-square)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-0D9488?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![BYOK](https://img.shields.io/badge/LLM-BYOK%20OpenAI--Compatible-0D9488?style=flat-square)](#-配置-llm)

中文 · [English](README.en.md)

</div>

> Chrome MV3 扩展。在任意网页唤起助手 → 抓取页面字段 → 用自然语言描述意图 → LLM 返回每个字段的建议值 → 预览/编辑后一键回填。BYOK，自带 OpenAI 兼容 endpoint。

---

## 演示

<!--
  把全流程演示 GIF 放到 docs/demo.gif（建议 ≤ 800px 宽、≤ 3MB）
  录制建议见 docs/README.md
-->

<div align="center">

<img src="docs/demo.gif" alt="全流程演示" width="720" />

<sub>📽️ <em>完整演示 GIF 待补</em> — 录制方法见 <a href="docs/README.md">docs/README.md</a></sub>

</div>

---

## ✨ 特性

- 🎯 **零选择器** —— 用元素编号映射法，对动态 class（Tailwind / CSS-in-JS / MUI）友好
- 🪄 **AI 读页面** —— 一键让 LLM 自动生成填写意图，也支持手动描述
- 🔒 **BYOK & 本地优先** —— 任意 OpenAI 兼容接口，配置只存在 `chrome.storage.local`
- ✅ **预览 + 确认** —— 每个字段可逐项编辑、勾选后再回填，不打扰
- 🧩 **React 兼容** —— 用 native setter + dispatch event 写值，绕开受控组件覆盖
- 📜 **可观测** —— 内置完整日志查看页（含 LLM prompt/response），支持本地 NDJSON 落盘

---

## 🚀 快速开始

### 1. 安装扩展

**方式 A：从 Release 下载（推荐）**

1. 到 [Releases](../../releases) 下载最新版 `chrome-assistant-vX.Y.Z.zip` 并解压
2. 打开 `chrome://extensions/`，右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择解压后的目录

**方式 B：从源码构建**

```bash
pnpm install
pnpm gen:icons    # 用 ImageMagick 渲染扩展图标（需 macOS: brew install imagemagick）
pnpm build        # 产物在 dist/
```

然后同方式 A 加载 `dist/` 即可。

### 2. 配置 LLM

点击工具栏扩展图标 → 侧边栏右上角 ⚙ 设置：

| 项 | 默认值 | 说明 |
|---|---|---|
| Endpoint | `http://localhost:3000/api/v1/llm` | 到 `/llm` 这一层，扩展会自动拼接 `/chat/completions` |
| API Key | `not-needed` | 本地代理可填 `not-needed`；公网 API 填你的 key |
| 模型 | `gemini-3.1-pro` | 任意 OpenAI 兼容模型名 |
| Temperature | `0.3` | 表单填写偏确定性，0~0.5 较合适 |

填写完毕点击「测试连接」，看到绿色勾即配置成功。

### 3. 使用

1. 进入要填写的网页（如：注册页、问卷、表单）
2. 点击工具栏扩展图标 → 侧边栏弹出
3. 点 **抓取页面字段** —— 扫描出可填字段
4. 选一种方式描述意图：
   - 🪄 **让 AI 读页面自动生成** —— LLM 会读取字段标签和页面摘要，给出合理意图模板，你可微调
   - ✍️ 或手动输入：例如 *"帮我填注册表，姓名张三，邮箱 a@b.com，订阅周刊"*
5. 点 **生成填写方案** —— LLM 返回每个字段的建议值
6. 在预览区可勾选/取消、改值
7. 点 **确认填写 N 个字段** —— 表单元素被绿色高亮 = 写入成功

---

## 📋 已知限制（MVP Non-Goals）

| 不支持 | 原因 |
|---|---|
| 闭合 Shadow DOM | 浏览器安全边界 |
| 跨域 iframe | 同源策略 |
| 富文本编辑器（Quill / CKEditor / TinyMCE） | 私有 API，不通用 |
| 文件上传字段 | 安全限制，扩展不能伪造 file 输入 |
| 多步表单 / 翻页 | MVP 边界，需要多轮 Agent 框架 |
| 验证码 | 不可绕过 |

遇到不支持的字段会显式提示「不支持」，不会静默失败。

---

## 🛠️ 开发

```bash
pnpm install
pnpm dev          # HMR 模式（保留 dist 同时热更新）
pnpm build        # 生产构建
pnpm typecheck    # 类型检查
pnpm gen:icons    # 重新生成扩展图标（需 ImageMagick）
pnpm verify       # CDP 端到端自动化验证（需 Chrome 开 9222 端口）
```

### 端到端验证（CDP 全自动）

要求 Chrome 用 `--remote-debugging-port=9222` 启动，且本扩展已加载到 `dist/`。

```bash
pnpm build && pnpm verify
```

会自动：新开测试 tab → 触发 EXTRACT_FIELDS / FILL_FIELDS → 读 DOM 断言 → 查日志埋点。退出码 0 = 通过。

---

## 🏗️ 项目结构

```
src/
├── shared/
│   ├── messages.ts         # 三端消息类型 + 字段/填写指令模型
│   ├── settings.ts         # chrome.storage 读写
│   ├── logger.ts           # 三端统一 logger（写本地目录 + ring buffer）
│   └── ui.tsx              # 共享 UI 原子（Button/Icon/Input...）
├── background/
│   ├── index.ts            # service worker 入口（消息路由）
│   └── llm.ts              # LLM 客户端（fetch + JSON 模式 + 错误兼容）
├── content/
│   ├── index.ts            # content script 入口
│   ├── extractor.ts        # 字段提取 + ELEMENT_REGISTRY
│   └── filler.ts           # native setter 回填 + 高亮
├── sidepanel/              # 侧边栏 UI（主交互流程）
├── options/                # 设置页 + 日志目录管理
└── logs/                   # 完整日志查看页

public/icons/               # 扩展图标（svg 源 + 4 张 PNG）
.github/workflows/          # CI：每次 push 自动 release
docs/                       # README 引用的演示资源
```

---

## 🤖 架构关键决策

1. **元素编号映射法** —— content script 给每个可交互元素分配数字 id，LLM 只输出 `{id, value}`，回填时反查元素。比让 LLM 输出 selector 命中率高得多。
2. **原生 sidePanel API** —— 不在页面里注入浮层 UI，避开 z-index/CSP/样式隔离。
3. **native setter + dispatch event** —— 写值用 `Object.getOwnPropertyDescriptor(...).set.call(el, v)` 然后派发 `input`/`change`，绕过 React 受控组件状态覆盖。
4. **BYOK + 单轮交互** —— 不存用户 profile、不做多轮记忆，配置只存 `chrome.storage.local`。

---

## 📦 Release & 自动化

每次 push 到 `master`，CI 会：

1. 读取最新 `v*` tag，自动 `patch + 1`
2. 同步版本到 `package.json`（`manifest.config.ts` 通过 `pkg.version` 自动取）
3. `pnpm install && pnpm gen:icons && pnpm build`
4. 把 `dist/` 打包成 `chrome-assistant-vX.Y.Z.zip`
5. 创建 GitHub Release，附带自动生成的 changelog

详见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

---

## 📜 License

MIT
