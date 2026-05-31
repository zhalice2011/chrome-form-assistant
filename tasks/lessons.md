# Lessons

记录被纠正的模式和应避免的反复犯错。每次会话开始回顾。

## 命名遮蔽：变量名 `log` 与 logger 实例冲突
**触发场景**：阶段 5-1 引入 `const log = createLogger(...)` 后，sidepanel 原本的 `const [log, setLog] = useState<string[]>` 被模块级 `log` 遮蔽，触发一堆 TS2339 错误（'info' does not exist on string[]）。
**教训**：
- React 状态用单字符通用名（log/data/info 这种）很容易被后续 import 遮蔽
- 引入新模块级常量前先 grep 已有同名变量
- 状态变量优先用更具体的名字（如 `logLines` / `displayedLogs`）

## crxjs 不识别 `match_origin_as_fallback`
**触发场景**：阶段 1 配 manifest 时加 `match_origin_as_fallback: true`，crxjs 当前版本类型不识别报错。
**教训**：crxjs 类型滞后于 Chrome 实际支持的 manifest 字段。MVP 阶段需要新字段时先验证 crxjs 是否支持，否则用 `as any` 绕或先省略。

## web_accessible_resources 的 html 必须显式列入 rollup input
**触发场景**：阶段 5-5 在 manifest 加了 logs/index.html 到 web_accessible_resources，构建后 dist 里 html 没编译。
**教训**：crxjs 只处理 manifest 主流程引用的页面（sidepanel/options/popup）。新增独立页面必须在 vite.config.ts 的 `rollupOptions.input` 里显式列出。

## SW 内部不能用 chrome.runtime.sendMessage 发给自己
**触发场景**：写 verify-e2e.mjs 时让 SW 自己调 `chrome.runtime.sendMessage({type:'LOG_QUERY'})` 触发自己注册的 listener，结果一律抛 "Could not establish connection. Receiving end does not exist."。
**教训**：`chrome.runtime.sendMessage` 是设计给"非 SW 端 → SW"的（content/sidepanel/options → background）。SW 内部直接调本地函数，或开 options 页等 page target 作为发送代理。
**应用**：CDP 自动化时，先 newTab 一个 chrome-extension://<id>/src/options/index.html，从这里发消息给 SW。

## chrome.tabs.sendMessage 不指定 frameId 会被 iframe 抢答
**触发场景**：用户在 OpenAI codex-for-oss 表单页（含 Marketo 跨域 iframe `mktoweb.com/index.php/form/XDFrame`）抓字段，sidepanel 报 "Could not establish connection. Receiving end does not exist"。即便手动注入 content script 后，PING 返回的是 mktoweb iframe 的 url 而非主 frame，EXTRACT 抓到 0 字段。
**教训**：content_scripts 的 `all_frames: true` 让所有 frame 都注册了 listener；`chrome.tabs.sendMessage(tabId, msg)` 不带 `frameId` 会广播到所有 frame，**第一个 sendResponse 的赢**——隐藏 iframe（Marketo / reCAPTCHA / 嵌入表单）经常抢答，导致主 frame 的真实表单被无视。
**应用**：sidepanel 给页面发消息时一律用 `{ frameId: 0 }` 只发主 frame。多 frame 字段聚合作为后续优化（用 `chrome.webNavigation.getAllFrames` + 逐 frame 发送）。

## crxjs 注入的是 loader，listener 注册有几百毫秒延迟
**触发场景**：扩展 reload 后 `chrome.scripting.executeScript` 同步返回，立刻 sendMessage 仍报 "Receiving end does not exist"。
**教训**：crxjs 的 content script 文件其实是 loader（约 5 行代码），通过 `import(chrome.runtime.getURL(realModule))` 异步加载真模块。loader 返回 ≠ 真模块加载完成 ≠ listener 注册。
**应用**：注入后必须 backoff 重试，不能依赖 executeScript Promise resolve 就立即通信。建议序列 [50, 100, 200, 400, 800] ms。

## verify 脚本污染了用户的真实 settings
**触发场景**：8.1 verify 测试 🪄 时为了断言"profile 信息出现"，往 chrome.storage.local 写入了"姓名: 验证-王五"等假数据。然后用户在真实站点用 🪄 时 LLM 老老实实按 profile 填了"验证-王五"，被骂"填了完全没用的数据"。
**教训**：自动化测试**绝不能改用户的真实持久化状态而不还原**。任何写入 chrome.storage / IDB / 本地文件的 verify 步骤，必须：
1. 在 setup 阶段先 `get` 一次原值并存到 ctx
2. cleanup 阶段（**包括 critical 失败分支**）还原；用户原本没值时改用 `remove`
3. cleanup 必须健壮：CDP 已断、任何步骤抛错都要兜住
**应用**：scripts/verify-e2e.mjs 的 1.3 步打开 options 后立刻备份 `ctx.savedSettings`；cleanup 在所有终止路径都还原；critical 失败分支也要 await cleanup。

## verify 脚本未关闭遗留 tab 导致 chrome.tabs.query 找错
**触发场景**：verify 反复跑后留下 7 个 example.com tab，下次 query 第一个匹配可能是旧 tab，但 newTab 又开了新的——导致抓字段返回了上次表单的字段名而当前 DOM 是简化的 2 个 input，fill 写到了旧 tab 上。
**教训**：CDP 自动化反复跑时务必有可靠的 cleanup（process.on SIGINT / try-finally），或者每次 verify 启动时清掉所有同 url tab。`tabs.query` 返回顺序不保证最新优先。
**应用**：verify-e2e.mjs 的 cleanup 需要在 critical 失败前也跑（用 try-finally 包 main()）。

## content_scripts 的 `<all_urls>` 不匹配 data: / chrome: / file: scheme
**触发场景**：verify 脚本里用 `data:text/html,...` 作为测试表单页，content script 完全没注入，`chrome.tabs.sendMessage` 报无 listener。
**教训**：MV3 content_scripts.matches 默认只覆盖 http(s) origins。要覆盖更多 scheme 必须显式列出（如 `["<all_urls>", "data:*"]` 也仍然不行——data: 不在 host_permissions 体系内）。
**应用**：测试 / 自动化场景用真实 http(s) 页面（如 example.com），用 CDP 注入 DOM 替换页面内容。
