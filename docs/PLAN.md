# 学习功能开发计划（第 0 阶段：核实结论）

核实日期：2026-11-24，分支 `feat/learning-tool`，基于上游 `imsai-sh/fish-pocket`。

可信度标记：
- 【代码】：读仓库代码或脚本得出
- 【CI】：在 CI 上跑过
- 【待真机】：只能在真机或模拟器上确认，目前没有确认

约定：App 名称和图标不使用「DeepTutor」字样。按 LICENSE 第 3 条，也不能用「Fish Pocket」的名称、图标和吉祥物。新名称待定，见 OPEN_QUESTIONS.md 第 2 条。

---

## 1. nodejs-mobile 的 Node 版本，能否启动多个实例

- **版本**：nodejs-mobile `24.20.0-0`，也就是 Node 24.20.0。下载地址钉在 `scripts/fetch-nodejs-mobile.sh` 第 8 行。CI 和本机跑测试都用 Node 24。【代码】
- **只能启动一个实例**：`app/DshIOS/NodeEngine.swift` 第 6–7 行写明 *"Node can be started only once per process, so this is a singleton for the app's lifetime"*。`NodeEngine.shared` 用 `started` 标志防止重复调用 `node_start`。引擎重启发生在这个实例内部，由 `main.mjs` 重新拉起 worker。【代码】
- **结论**：学习功能不能另起一个 Node，必须跑在 DSH 同一个引擎进程里，做成 DSH 插件。真要隔离重活（比如大批量建索引），可以用 `node:worker_threads`。`native/root/test/conformance.mjs` 里有 Worker 的检查，但它靠 `scripts/test-root-sim.sh` 在模拟器上手动跑，不在 CI 里，没有运行记录可查【待验证】。

## 2. 能否使用原生 Node 模块；SQLite 放在哪一侧

- **原生模块**：不能用 `dlopen` 加载 `.node` 文件，App Store 也不允许动态加载未随 App 签名的代码。仓库的做法是把 C/ObjC 代码直接编进 App，再用 `napi_module_register` 注册成「链接绑定」，JS 侧通过 `process._linkedBinding('名字')` 调用。现有的绑定有 `dsh_git`、`dsh_image`、`dsh_ios_native`、`dsh_root`、`dsh_python`、`dsh_ffmpeg`，见 `native/*` 和 `app/project.yml` 的 sources。npm 上带预编译 `.node` 的包（better-sqlite3、sqlite3 等）在 iOS 上都不能用。【代码】
- **SQLite：放 Node 侧，用内置的 `node:sqlite`**，不放 Swift 侧，也不用 WASM。理由：
  - Node 24 自带 `node:sqlite`，不需要任何原生模块。
  - `native/root/test/conformance.mjs` 第 111–124 行写了 `DatabaseSync` 在 DELETE 和 WAL 两种日志模式下的检查，要在真的 NodeMobile 上跑。但它要靠 `scripts/test-root-sim.sh` **在模拟器上手动运行**，不是真机，也不在 CI 里，没有运行记录可查。
  - **【CI：模拟器】2026-11-25 run 45626288772（28cd234）**：新加的 `scripts/test-learning-sim.sh` 用 iPhone 模拟器里真实的 NodeMobile（node v24.20.0，SQLite 3.53.4）跑了一遍。node:sqlite 能打开 /home/dsh 下的文件，WAL 能落盘；学习库的读写、检索、清空都通过。真机还没验证。
  - DSH 自己的会话全文检索 `@deepseek-ai/dsh-session-query-sqlite` 就用 `node:sqlite` 加 FTS5。它是 `dsh-base` 的依赖，学习功能用同一套技术栈，最符合「复用、不另起一套」。【代码】
  - 放 Swift 侧的话，每次查询都要多走一层 JS↔Swift 通信，还要新写一套绑定。用 WASM（sql.js、wa-sqlite）则更慢、包更大，而且和 DSH 用的不是同一个 SQLite。
- **待确认**：
  - nodejs-mobile 编进去的 SQLite 带不带 FTS5，以及中文检索要用的 `trigram` 分词器。DSH 的会话检索用了 FTS5，说明大概率带，但具体分词器名在本地看不到，没有核实。（当时的判断）
  - **【CI：模拟器】已确认**（同一次 run）：NodeMobile 的 SQLite 带 FTS5 和 `trigram` 分词器，三个字的中文能命中，两个字命中不了，所以退回 LIKE 是必须的。
  - 原计划在第 1 个里程碑加一个 CI 能跑的检查（已完成，见上一条和 DECISIONS.md D9）。如果以后 NodeMobile 升级后不带 trigram，学习库会自动退回 LIKE（meta.fts=none），测试覆盖了这条路径。

## 3. 向量相似度放 Swift（Accelerate）还是 Node

- **现状**：`native/ios-native/caps_nlp.m` 用 `NLEmbedding sentenceEmbeddingForLanguage:` 和 `distanceBetweenString:andString:` 按语义排序，向量只在 ObjC 侧使用，不交给 JS。仓库里还没有用过 Accelerate。【代码】
- **结论：向量由 Swift/ObjC 生成，相似度在 Node 里算。**
  - 生成向量必须在原生侧，`NLEmbedding` 只有系统框架里才有。做法是在 `dsh_ios_native` 里加一个返回向量的方法（`vectorForString:`），以 `Float32Array` 交给 JS。
  - 向量以 BLOB 形式存进上面那个 SQLite，和文本块放在一起。
  - 相似度用 JS 写一个循环算点积或余弦。学习资料的规模大约是几千个文本块乘几百维，一次查询是百万次乘加，在 JS 里是毫秒级，不值得为它新建一条原生通道。
  - 只有当真机实测查询超过约 50 ms 时，才考虑在原生侧加 Accelerate（`vDSP_dotpr`）批量计算，同时在 project.yml 加上 Accelerate.framework。
- **待确认**：NLEmbedding 句向量的维度，以及中文是否可用。中文句向量可能没有，或要下载语言资源，所以要准备退路，可以用可配置的 OpenAI 兼容 embedding provider（Key 存 Keychain；DeepSeek 官方 API 没有 embedding 接口，仓库里也没有现成的 embedding 服务），或者只做关键词检索。【待真机】

## 4. DSH 现有的 skills、插件、会话存储格式（必须复用或兼容）

- **插件**：都是 cordis 插件，放在 `engine/plugins/<名字>/index.mjs`，在 `engine/ios.patch.yml` 里登记启用（第 101–129 行，比如 ios-host、ios-native、ios-call、fish-pocket）。【代码】
  - 新功能做成 `engine/plugins/<学习插件>/index.mjs`，用同样的方式登记。
  - 工具注册、上下文注入的写法参照 `ios-call` 和 `ios-voice-message`。
- **Skills**：放在 `engine/skills/<名字>/SKILL.md`，开头是 YAML 头（`name`、`description`），可以带 `scripts/` 目录（参照 `mini-apps`）。由 `engine/main.mjs` 第 45 行的 `DSH_BUNDLED_SKILL_DIR` 指向 `engine/skills` 加载。【代码】
  - 学习功能的用法说明写成一个新的 skill。
- **会话**：由 `@deepseek-ai/dsh-session-persistence-jsonl` 存成 `.jsonl` 或 `.jsonl.zstd`，格式版本 `SESSION_FORMAT_VERSION = 4`，有 v0 到 v4 的迁移包。全文检索是从会话派生出来的 SQLite 索引（`dsh-session-query-sqlite`，schema 版本 8，可以删掉重建）。【代码】
  - 学习对话直接用普通的 DSH 会话，不自建聊天记录，也不改会话格式。
- **学习自己的数据**：资料、文本块、向量、卡片和复习进度，DSH 里没有对应的东西。这部分单独放一个 SQLite 文件，放在 DSH 数据目录下（`/home/dsh/.dsh/` 之下的子目录，具体路径在第 1 个里程碑确定）。
  - 照 `dsh-session-query-sqlite` 的做法设 `application_id` 和 schema 版本号，打开时校验。
  - 和会话的关联只存 session id，不复制会话内容。
- **iOS 目录**：home `/home/dsh`，文档 `/home/dsh/Documents`，App 与引擎共享 `/home/dsh/.ios`，DSH 数据 `/home/dsh/.dsh`。都是 `native/root` 映射出来的虚拟路径，见 `app/DshIOS/EnginePaths.swift`。【代码】

## 5. LICENSE 内容及其对分发（含 App Store）的影响

LICENSE 是 MIT 许可证加一段附加条款（Additional Terms）。附加条款与 MIT 冲突的地方，以附加条款为准。【代码】

- **个人使用不受限制**：下载、构建、运行、修改都不需要告诉任何人；也可以为了向原仓库提 PR 而 fork。
- **第 1 条，商用要书面授权**：收费、内购、订阅、广告、打包进付费产品，都要先在原仓库开 issue 申请授权。用 App 做自己的工作不算商用。
- **第 2 条，公开分发修改版之前必须先开 issue**：条款明确列出了应用商店、TestFlight 和可下载的构建包。issue 里要写清改了什么、做什么用、怎么分发。
- **第 3 条，注明来源、使用自己的名字**：
  - 必须写明「基于 Fish Pocket」，并附 https://github.com/imsai-sh/fish-pocket 的链接。
  - 必须用自己的名称和图标，不能冒充官方版本。
  - 不授予「Fish Pocket」名称、App 图标和吉祥物的任何权利。吉祥物另外按 CC BY-NC-SA 4.0 授权，这是非商用、相同方式共享的许可，所以不能用。
- **第三方组件**（THIRD_PARTY_NOTICES.md）：
  - FFmpeg 按 LGPL 2.1 使用，做成独立的动态框架。LGPL 和 App Store 条款是否兼容，业界有争议。正式上架前要评估，或者在学习版里去掉 FFmpeg。
  - libgit2 是 GPLv2 加链接例外，未修改、静态链接，按例外条款可以使用。
- **其他要改的东西**：Bundle ID 前缀 `com.wsw` 和 App Group `group.com.wsw.dsh-ios` 是原作者的，自己分发时要换成自己的。
- **对本项目的影响**：
  - 只是自己装在自己手机上用，什么都不用做。
  - 上 TestFlight 或 App Store 之前，必须先在原仓库开 issue，换名称、图标、吉祥物和 Bundle ID，在「关于」里注明来源和链接。
  - 想收费，还要先拿到书面授权。
- **灰色地带**：为了跑 CI，我们建了公开 fork `6666644444/fish-pocket`。条款允许「为提 PR 而 fork」，但公开放着修改版源码算不算「公开分发修改版」，没有写明。见 OPEN_QUESTIONS.md 第 3 条。

以上是按条款文字做的整理，不是法律意见。

---

## 汇报口径（每个里程碑都照此写）

- **CI 编译并通过单元测试**：只写 CI 上实际跑过并且全绿的东西。
- **未经真机或模拟器人工验证**：所有界面、交互，以及上面标【待真机】的项，附验证步骤清单。
- 界面部分只保证编译通过，不声称外观或交互正常。

---

# 里程碑 1 起补充的设计（2026-11-25）

## 6. 现有架构

```
SwiftUI 外壳（app/DshIOS）
  ├─ NodeEngine：整个进程只启动一个 Node（node_start），以单例形式存在
  │    └─ engine/main.mjs → worker 线程里跑 DSH（boot.mjs，`dsh web`）
  │         ├─ DSH 官方插件（node_modules/@deepseek-ai/*，不修改）
  │         ├─ ds-bot（Bot、群聊、Bot 记忆 = 每个 Bot/团队各一份 MEMORY.md）
  │         └─ 本项目插件（engine/plugins/*，在 ios.patch.yml 末尾的 insert 里登记）
  │              ios-host / ios-native / ios-speech / ios-call / ios-voice-message / fish-pocket / learning（新）
  ├─ EngineClient：用 launch token 换 cookie，之后 POST /api/<method>
  │    插件自己的路由用 ctx.connection.fetch.register 挂在同一个端口上（例如 /api/ios-voice-message/settings）
  └─ 原生绑定：C/ObjC 代码编进 App，通过 process._linkedBinding 调用（dsh_git、dsh_ios_native、dsh_root…）
路径：native/root 把 /home/dsh 映射到 App 容器
  /home/dsh/.dsh   = DSH_HOME（设置、会话、Bot 数据；recovery.mjs 会把根目录和 profiles/web 两层里的小文件当成设置）
  /home/dsh/.ios   = DSH_IOS_DATA（App 和引擎共享）
  /home/dsh/Documents = 会通过「文件」App 共享，学习数据不放这里
```

学习记忆和 Bot 记忆完全分开：Bot 记忆是 ds-bot 的 MEMORY.md，界面在 `BotDetailView.swift` 的 `BotMemoryPage`；学习记忆是学习库的 `memories` 表。「清空学习记忆」只清空这张表。

## 7. 回归检查表（每个里程碑都要对照）

| # | 功能 | CI 能自动检查吗 | 人工检查步骤 |
|---|---|---|---|
| 1 | 引擎能启动，插件全部加载、没有报错 | 部分（编译和单测）| 打开 App → 设置 → 插件：每一行都没有报错 |
| 2 | 普通会话：工具卡片、流式回复、自动标题 | 否 | 新建会话，发送「用 bash 运行 node -e "console.log(6*7)"，然后一句话告诉我结果」 |
| 3 | 老会话能读出来，也能接着聊 | 否 | 先装旧版本建一条会话，再覆盖安装新版本，打开这条会话接着发一句 |
| 4 | 子智能体能追问、能中断 | 否 | 让 agent 起一个子智能体，然后追问、再中断 |
| 5 | Bot 聊天、群聊的回复能显示 | 否 | Bot 和群里各发一条消息 |
| 6 | Bot 记忆页 | 否 | Bot 详情 → 记忆：内容和升级前一样 |
| 7 | 插件页、插件商店、设置、计划任务、连接器、本机能力、Mini Apps | 否（scripts/smoke-sim.sh 能截图） | 逐页打开看一遍 |
| 8 | 语音输入、朗读、语音消息、语音通话 | 否 | 各操作一次 |
| 9 | 浏览器、手机控制、分享扩展、小组件、手表、快捷指令 | 否 | 各操作一次 |
| 10 | iPad / iPhone Duo 的分栏和 Tab 布局 | 否 | 在这些机型的模拟器上打开首页 |
| 11 | 「引擎修复」页的恢复和重置 | 部分（recovery.test.mjs，学习库不会被当成设置：learning-store.test.mjs）| 重置一次之后，学习数据仍然在 |
| 12 | 学习功能（从 M1 起新增）：笔记本、学习记忆 | Node 部分能 | 见各里程碑的汇报 |

## 8. 学习库的数据模型（M1）

- 文件路径是 `$DSH_HOME/learning/learning.db`，放在 `~/.dsh` 下面一层的子目录里，原因见第 6 节。用 node:sqlite，开 WAL 和 foreign_keys。
- `PRAGMA application_id = 0x4C524E31`（'LRN1'），和 dsh-session-query-sqlite 的 1146308689 不同。`user_version` 记录 schema 版本。打开时，如果 application_id 不对、库里已有别的表、或者版本比当前代码新，就拒绝打开，并且不改动这个文件。
- 迁移按顺序执行，每一步只新增内容：
  - v1：`notebooks`、`notes`（notebook_id 外键，ON DELETE CASCADE）、`memories`（content、source=user|agent）、`meta`；
  - v2：`notes_fts`（fts5，content='notes'，tokenize='trigram'）加三个同步触发器。如果 SQLite 不带 trigram，就在 meta 里记 `fts=none`，搜索全部走 LIKE。
- 搜索：查询词按空白切开，各词之间是 AND 关系。所有词都在 3 个字及以上并且有 trigram 时，用 FTS（按 bm25 排序）；否则用 LIKE，%、_、\ 都会转义。

## 9. Swift 和 Node 之间的接口（M1）

`POST /api/learning/<method>`，请求体是参数的 JSON 对象。
- 成功：200 `{ ok: true, result }`
- 失败：`{ error: { kind, message } }`。kind 和状态码对应：invalid=400，not-found=404，conflict=409，unavailable=503，internal=500。

| 方法 | 参数 | 返回 |
|---|---|---|
| status | — | { schemaVersion, latestSchemaVersion, search: 'trigram' \| 'none' } |
| notebooks.list / get / create / update / delete | get、delete 要 {id}；create 要 {title}；update 要 {id, title} | 笔记本对象 {id, title, noteCount, createdAt, updatedAt} |
| notes.list | {notebookId, limit?, offset?} | 笔记对象数组 |
| notes.get / create / update / delete | get、delete 要 {id}；create 要 {notebookId, title?, body?}；update 要 {id, title?, body?} | {id, notebookId, title, body, createdAt, updatedAt} |
| notes.search | {query, notebookId?, limit?} | { mode: 'fts' \| 'like' \| 'none', results: [{id, notebookId, title, excerpt, updatedAt}] } |
| memories.list / get / create / update / delete | create 要 {content, source?}；update 要 {id, content} | {id, content, source, createdAt, updatedAt} |
| memories.clear | — | { deleted: n }，只清学习记忆 |

时间是毫秒级的时间戳。限制：标题最多 200 字，正文最多 100 万字，单条记忆最多 4000 字，一页最多 200 条。

## 10. Deep Research 的状态机和断点恢复（只写设计，代码在 M5 实现）

- 状态：`planned → searching(i/n) → synthesizing → writing → done`，另有 `failed`、`cancelled`。每一步都有输入、输出和尝试次数。
- 落盘：每个任务一行记在学习库的 `research_jobs` 表里，每一步的结果记在 `research_steps` 表里（M5 迁移时新增）。一步完成后，在同一个事务里写入结果并推进状态，所以要么整步都写进去，要么都不写。
- 恢复：引擎启动时扫描没有到终态的任务，标记为 `paused`。用户点「继续」后，从最后一个完成的步骤往下做。步骤的唯一键是 `job_id + 步骤序号`，所以重复恢复也不会写出两份结果。
- 取消：先置 `cancelRequested`，当前这一步做完后检查这个标记，然后转到 `cancelled`。已经完成的步骤保留。
- 进度：`research.status` 返回当前状态、已完成数 / 总数，以及最近一步的摘要。App 定时拉取。
- iOS 后台：App 退到后台时，用 `beginBackgroundTask` 争取一点时间把当前这一步做完并落盘，而不是去跑完整个任务。只有在用户允许时，才申请 BGProcessingTask，标识用 `$(PRODUCT_BUNDLE_IDENTIFIER).task.learning-research`（落在 project.yml 已有的 `.task.*` 通配范围里），在后台接着跑剩下的步骤。默认情况下只在前台运行。
