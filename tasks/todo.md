# Chrome 网页表单助手 - TODO

## 项目目标
Chrome MV3 扩展：用户在网页唤起助手 → 抓取页面 → 用户对话输入意图 → 调 LLM → 预览 → 回填表单。BYOK OpenAI 兼容接口，单轮交互。

## 阶段 1：扩展骨架（先跑通三端通信）✅ 代码完成，待用户验证
- [x] 安装依赖：vite、@crxjs/vite-plugin、react、react-dom、typescript、tailwindcss、zustand
- [x] 配置 `vite.config.ts`、`tsconfig.{json,app,node}`、`tailwind.config.js`、`postcss.config.js`
- [x] `manifest.config.ts`：MV3、`side_panel`、`background.service_worker(module)`、`content_scripts(all_frames:true)`、`permissions:["activeTab","scripting","storage","sidePanel","tabs"]`、`host_permissions:["<all_urls>"]`
- [x] `src/sidepanel/`：React + Tailwind UI + Ping 按钮
- [x] `src/background/index.ts`：`setPanelBehavior({openPanelOnActionClick:true})`
- [x] `src/content/index.ts`：监听 PING，回 `{ok, pong, url}`
- [x] `pnpm build` 通过（manifest/sidepanel/background/content/options 产物齐全）
- [ ] **用户手动验证**：加载 `dist/` → 点扩展图标 → 侧边栏出现 → 点 Ping 按钮 → 看到 `ok: pong from content: hello from sidepanel`

注：`match_origin_as_fallback` 因 crxjs 类型限制暂未启用，阶段 2/4 处理 about:blank/srcdoc iframe 时再加。

## 阶段 2：字段提取器 ✅ 代码完成，待用户验证
- [x] `src/content/extractor.ts`：扫描 input/select/textarea/contenteditable + 模块级 ELEMENT_REGISTRY (Map<id, Element>)
- [x] label 推断 8 级优先级：label[for] → 包裹 label → aria-labelledby → aria-label → title → 邻近文本 → placeholder → name
- [x] radio 按 name 分组合并成单个字段（fieldset>legend 优先取整组 label），select 抽 options
- [x] 可见性过滤：display:none / visibility:hidden / 0尺寸 / disabled / readonly / hidden 类型 / submit/button/file
- [x] sidePanel 字段表 UI：id/label/类型/当前值，options 预览前 3 项，required 红星标记
- [x] 错误处理：content script try/catch 包住，错误透传给 UI
- [x] `pnpm build` 通过
- [ ] **用户手动验证**：在 3 个站点测试
  - Google Form（普通 HTML 表单）
  - 一个普通注册页（如 GitHub 注册）
  - 一个 React/MUI 站点
- [x] **不在本阶段做**：iframe 跨域、Shadow DOM、富文本（已确认）

注：当前只抓主 frame；同源 iframe 内的字段会被 content script 注入但 sidepanel 没遍历 frame 拉取。后续若验证发现需要再补。

## 阶段 3：LLM 客户端 + 设置页 ✅ 代码完成，待用户验证
- [x] `src/shared/settings.ts`：chrome.storage.local 读写 + onChanged 订阅
- [x] `src/options/OptionsApp.tsx`：endpoint/apiKey/model/temperature 表单 + 保存 + "测试连接"按钮 + 恢复默认
- [x] `src/background/llm.ts`：OpenAI 兼容 fetch、response_format=json_object、60s 超时、AbortController、ZenVFX 错误格式识别、JSON fences 容错解析、非法 id 过滤
- [x] `src/background/index.ts`：监听 LLM_GENERATE_FILLS，从 storage 读 settings，调 generateFills，回 {ok, fills, debug}
- [x] sidepanel 加 textarea 输入意图 + "调用 LLM" 按钮 + FillsPreview 组件（显示 id/label/建议值/reason，token 用量）
- [x] sidepanel 顶部加 ⚙ 设置按钮 → openOptionsPage
- [x] 默认配置：endpoint=http://localhost:3000/api/v1/llm，apiKey=not-needed，model=gemini-3.1-pro，temp=0.3
- [x] `pnpm build` 通过
- [ ] **用户手动验证**：见下面"验证步骤"

## 阶段 4：回填器 + 确认流程 ✅ 代码完成，待用户验证
- [x] `src/content/filler.ts`：分类型实现写值
  - input/textarea：native setter（缓存 prototype descriptor）+ input + change
  - select：native setter + change，兜底用 label 匹配 option
  - checkbox：click()（让框架 onChange 自然触发）
  - radio：在同 form/document 范围找 name 同组的目标 value，click()
  - contenteditable：innerText + input
- [x] 单字段失败不中断整批（每个字段返回独立 FillReport: ok/not-found/unsupported/error）
- [x] 视觉反馈：填写后元素加 2 秒绿色 box-shadow 高亮，结束后还原 inline style
- [x] sidepanel DraftPreview 组件：每行可勾选/取消、可编辑 value
  - select/radio：渲染下拉，选项不在列表时给出"⚠ 不在选项中"提示
  - checkbox：渲染 true/false 下拉
  - 长文本（>50 字符）：textarea
  - 其他：text input
- [x] 填写完成后显示状态徽章（✓已填 / ×失效 / ⊘不支持 / ×失败）+ 失败原因
- [x] 填写完后按钮变为"重新抓取页面（继续填写其他字段）"
- [x] `pnpm build` 通过
- [ ] **用户手动验证**：见下面"验证步骤"

## Review（每阶段完成后填）

### 阶段 1
- 技术栈落地：Vite 5 + @crxjs/vite-plugin 2.4 + React 18 + TS 5.9 + Tailwind 3.4 + zustand 4.5
- 三端通信通道：sidePanel React UI → `chrome.tabs.sendMessage` → content script `chrome.runtime.onMessage` → 同步 sendResponse 回 pong
- 已知坑：crxjs 当前类型不识别 `match_origin_as_fallback` 字段（虽然 Chrome 138+ 已支持），暂时省略，记入 todo 后续补
- 构建产物 ~150KB（gzip ~46KB），符合预期
- 下一步：阶段 2 字段提取器，先在 content script 实现 DOM 扫描 + label 推断 + 编号 Map

### 阶段 2
（待填）

### 阶段 3
- LLM 调用放 service worker：避免页面 CSP、key 不暴露、host_permissions 让请求不走页面 CORS
- Prompt 设计 8 条硬约束（id 必须存在、value 用 option.value 不是 label、checkbox 用 "true"/"false"、不确定别返回...）
- JSON 解析三层兜底：直接 parse → 剥 ```json fences → 找首尾花括号
- 错误格式兼容：HTTP 非 200 时同时支持 ZenVFX `{success,error}` 和 OpenAI `{error}` 两种结构
- 默认 temperature=0.3 偏确定性（表单填写不需要创意）
- 设置页"测试连接"按钮独立做了一次最小调用（max_tokens=20），方便用户隔离 LLM 不通 vs 表单逻辑 bug

## 阶段 6：CDP 端到端自验证 ✅ 通过
- [x] scripts/cdp.mjs（无依赖 CDP 客户端：listTargets / connect / evalIn / waitFor）
- [x] scripts/verify-e2e.mjs 17 项检查
- [x] pnpm verify 命令
- [x] **17/17 通过**：CDP 通路、扩展加载、SW、日志注入查询、字段抓取、label 推断、回填全类型、DOM 校验、日志埋点、LLM 真实调用、prompt 约束、React valueTracker 兼容、**扩展 reload 后已打开 tab 的连接修复**

## 阶段 7：真实站点适配修复 ✅ 完成
来自用户反馈：在 OpenAI codex-for-oss 日文表单页报 "Could not establish connection. Receiving end does not exist"。
- [x] **修复 1**：sidepanel/messaging.ts 实现"按需注入兜底 + backoff 重试"——已打开 tab 上 content script 失联时自动调 chrome.scripting.executeScript 注入，crxjs loader 异步加载完成后 50/100/200/400/800ms backoff 重试
- [x] **修复 2**：所有 sidepanel → content 通信加 `{ frameId: 0 }`——只发主 frame，避免 Marketo / reCAPTCHA 等隐藏 iframe 抢答
- [x] **修复 3**：ContentScriptUnavailableError 友好错误提示——chrome:// / file:// / CSP 阻断时给出明确原因
- [x] verify 6.3 步覆盖 reload 场景；test-fix.mjs 在真实 OpenAI 表单页验证 13 字段全部抓到（含日文 label）

## 阶段 5：日志追溯系统（FSA + ring buffer + 三端 logger）✅ 代码完成，待用户验证
- [x] 5-1: shared/log-types.ts + shared/logger.ts (createLogger + sessionId + 200ms 去重 + 64KB 截断 + 失败降级 console)
- [x] 5-2: background/log-store.ts (1000 条 ring buffer + pending 队列 + 1s 防抖/50 条阈值 flush + LOG_APPEND/QUERY/CLEAR/FORCE_FLUSH 消息)
- [x] 5-3: background/fs-log-writer.ts (FSA 写入 + 当天文件名 + 10MB 滚动到 -2.log + ensurePermissionOrFail + setBadgeText 通知) + shared/idb-handle.ts (轻量 60 行 IDB 包装) + chrome.alarms 30s 周期 forceFlush
- [x] 5-4: options/OptionsApp.tsx 加 LogDirSection (showDirectoryPicker + requestPermission 同步路径调用 + queryPermission 状态显示 + 重新授权 + 移除)
- [x] 5-5: src/logs/{index.html,main.tsx,LogsApp.tsx} 独立日志页 (级别/来源/模块/关键字/sessionId 过滤 + 自动刷新 + 行展开 + NDJSON 导出 + 清空内存) + manifest web_accessible_resources + vite.config rollupOptions input + sidepanel 顶部"📜 日志"按钮
- [x] 5-6: 三端埋点：sidepanel(click.extract/askLlm/fill + extract.done/askLlm.done/fill.done) + content(extract.start/done + fill.start/done + fill.field.ok/failed + extractor.scan.summary) + background(sw.startup/onInstalled/onStartup + llmGenerateFills.start/ok/error + llm.request 含 fullPrompt + llm.response 含 rawText 完整原文 + llm.parsed/invalidIdsFiltered/timeout/networkError) + options(click.save/testConnection + logDir.pickStart/set/permissionDenied/reauthorize)
- [x] `pnpm build` 通过
- [ ] **用户手动验证**：见下面"验证步骤"

### 阶段 5
- 三端 logger 设计：background 用 directSink 直写 store，其他端走 chrome.runtime.sendMessage(LOG_APPEND)，调用方无感知；console 始终同步打一份方便看
- 200ms 去重防 React StrictMode 双调；64KB 单条截断；失败永远 catch + console，绝不阻塞业务
- FSA 三大坑全部规避：showDirectoryPicker 只能 sidepanel/options 调（不能 SW）；requestPermission 必须用户激活同步路径（写在 onClick 内 await 之前）；每写都新开 writable+seek+write+close（长 stream SW 休眠就丢）
- IDB 替代 chrome.storage：DirectoryHandle 必须结构化克隆，chrome.storage 序列化 JSON 存不下
- chrome.alarms 30s 周期兜底 forceFlush，防 SW 突然休眠丢最后几条
- web_accessible_resources 注册的 html 必须在 vite rollupOptions.input 显式列出，否则 crxjs 不会编译
- 命名遮蔽教训：sidepanel 原本有 `const [log, setLog] = useState<string[]>` 状态名，引入 logger `const log = createLogger(...)` 后被遮蔽，状态变量改名 logLines 解决（没察觉到 React 状态钩子被遮蔽是常见坑）

### 阶段 4
- React/Vue 兼容关键：用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` 缓存原生 setter，写值时 .call(el, value) 绕过框架的 value 拦截，再 dispatch input + change 事件让框架同步内部 state
- checkbox 走 click() 而非直接改 .checked：让 React/Vue 的 onChange handler 自然触发，避免状态不一致
- radio 在同 form 内按 name + value 找目标元素，click()
- 高亮用 box-shadow important（不污染 outline/border 的现有样式），2 秒后还原 inline style 的 box-shadow / transition 两个属性
- DraftPreview 给用户三种交互：勾选/取消、改值、重新生成（全 disable 状态在填写后切换）
- select/radio 不在 options 内时显式标"⚠ 不在选项中"——LLM 偶尔会自由发挥，让用户能看见
