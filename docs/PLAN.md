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
| 12 | 学习功能（从 M1 起新增）：笔记本、学习记忆；M2 起：三种学习模式、学习记忆注入开关、我的 Skills；M3 起：知识库导入、搜索、向量设置；M4 起：题库与错题本、出题测验模式里的 learning_quiz 工具；M5 起：deep_research 工具、深度研究页；M6 起：学习数据（导出、导入、备份、恢复、一键删除） | Node 部分能 | 见各里程碑的汇报 |
| 13 | 普通会话不受学习功能影响（M2 起） | 能（learning-modes.test.mjs：没有模式的会话原样通过） | 新建普通会话发一句话，确认回答方式和以前一样 |

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

## 10. Deep Research 的状态机和断点恢复（M1 时的设计；M5 实际按 §14 的方案 C 实现，BGProcessingTask 没有做）

- 状态：`planned → searching(i/n) → synthesizing → writing → done`，另有 `failed`、`cancelled`。每一步都有输入、输出和尝试次数。
- 落盘：每个任务一行记在学习库的 `research_jobs` 表里，每一步的结果记在 `research_steps` 表里（M5 迁移时新增）。一步完成后，在同一个事务里写入结果并推进状态，所以要么整步都写进去，要么都不写。
- 恢复：引擎启动时扫描没有到终态的任务，标记为 `paused`。用户点「继续」后，从最后一个完成的步骤往下做。步骤的唯一键是 `job_id + 步骤序号`，所以重复恢复也不会写出两份结果。
- 取消：先置 `cancelRequested`，当前这一步做完后检查这个标记，然后转到 `cancelled`。已经完成的步骤保留。
- 进度：`research.status` 返回当前状态、已完成数 / 总数，以及最近一步的摘要。App 定时拉取。
- iOS 后台：App 退到后台时，用 `beginBackgroundTask` 争取一点时间把当前这一步做完并落盘，而不是去跑完整个任务。只有在用户允许时，才申请 BGProcessingTask，标识用 `$(PRODUCT_BUNDLE_IDENTIFIER).task.learning-research`（落在 project.yml 已有的 `.task.*` 通配范围里），在后台接着跑剩下的步骤。默认情况下只在前台运行。

## 11. 学习模式、学习记忆注入、自定义 Skills（M2）

### 11.1 三种模式 = 三个随包 skill

| 模式 id | skill（`engine/skills/<名>/SKILL.md`） | 做什么 |
|---|---|---|
| `qa` | `learning-qa` | 普通问答：先给答案，再讲原因，最后一句确认 |
| `socratic` | `learning-socratic` | 引导式学习：一次只问一个问题，不直接给出最终答案；学习者明确要两次才给 |
| `quiz` | `learning-quiz` | 出题测验：一次一题，单选（A–D）或简答，批改并讲解，默认 5 题后小结。M2 只是对话，题目不进题库（题库在 M4） |

- skill 由 `dsh-skill-filesystem` 的随包根（`DSH_BUNDLED_SKILL_DIR` = `engine/skills`，`scripts/build-engine.sh` 原样拷进 App）加载，所以在任何会话里也能 `/learning-socratic` 调用。
- 学习会话就是普通 DSH 会话（JSONL v4，不改格式）。App 在「设置 → 学习 → 开始学习」用 `AppModel.createSession` 建会话，再调 `sessions.setMode` 记下模式。
- Agent 预设没有用，原因见 DECISIONS.md D11。

### 11.2 每一轮注入什么（`agent/pre-step`，写法同 ios-call）

只对**学习库里有模式记录的会话**生效；其他会话什么都不加。条件：这一回合的第 1 步、带新消息、没被拒绝或中止。

注入的是一条 `role: user`、`source.kind: 'learning-context'`、`form: 'snapshot'` 的消息，App 的时间线不显示。内容分两节：

1. `learning-mode`：这个会话第一次进入某个模式时，放该 skill 的完整正文，并在 `session_modes.announced` 记下；之后每轮只放一行提醒（「继续按 learning-xxx 的说明；如果已经看不到，就加载这个 skill」）。换模式会清空 `announced`，下一轮重新放完整正文。
2. `learning-memory`（设置开着时）：按相关度挑出的学习记忆。

记忆筛选（`modes.mjs` 的 `pickMemories`，参数初值见 D13）：
- 相关度：把用户这一轮的文字和每条记忆切成 token（拉丁字母/数字的词 ≥2 个字符；中日韩文字取相邻两字），相关度 = 共有 token 数 / √(记忆的 token 数)。
- 取相关度 > 0 的前 3 条（同分时较新的优先）；不足 3 条时，再补 1 条最近更新的。
- 截断：每条最多 300 字，合计最多 800 字（按 Unicode 码点计），被截的结尾加「…」；剩余空间不到 40 字时不再加。空白折叠成单个空格。
- 只看最近更新的 500 条记忆。

出错（学习库打不开、skill 文件读不到）时只记一条 warn，这一轮照常进行，不带注入。

### 11.3 学习库 v3

- `session_modes(session_id TEXT PRIMARY KEY, mode TEXT CHECK IN ('qa','socratic','quiz'), announced TEXT, updated_at INTEGER)`。只存 session id。
- 设置放在 `meta`：`inject_memories` = `on` / `off`，没有这一行时视为 on。
- 打开顺序改为：先校验 application_id 和版本，再切 WAL（M1 的写法会先把别人的数据库切成 WAL 再拒绝，改了文件头）。

### 11.4 自定义 Skills

- 位置：`$DSH_HOME/skills/<name>/SKILL.md`，即 dsh-skill-filesystem 的 `user-dsh` 根（rank 400）。DSH 监视这个目录，新增、修改、删除不用重启。它在 `$DSH_HOME` 下一层，`recovery.mjs` 的 settingsFiles 只看 `$DSH_HOME` 根和 `profiles/web` 里的文件，所以不会被「重置设置」移走。
- 写出的格式：`name`（kebab-case，规则就是 `@deepseek-ai/dsh-skill` 的 `isSkillName`）、`description`、可选 `whenToUse`，值写成 JSON 字符串（YAML 双引号标量）；另加 `metadata: { created-by: dsh-learning }` 作为「这里建的」标记。写入用临时文件加 rename。
- 只改这里建的：没有标记的（Agent 写的、手动放的、平铺的 `<name>.md`）可以列出和查看，但不改、不删。`learning-` 开头的名字留给随包模式。删除只删 `SKILL.md` 和随后变空的文件夹，文件夹里有别的文件就拒绝。

### 11.5 接口（在 §9 的基础上新增）

| 方法 | 参数 | 返回 |
|---|---|---|
| settings.get / settings.update | update 要 {injectMemories: bool} | {injectMemories} |
| modes.list | — | [{id, skill}] |
| sessions.getMode | {sessionId} | {sessionId, mode, announced, updatedAt} 或 null |
| sessions.setMode | {sessionId, mode: 'qa'\|'socratic'\|'quiz'\|null} | 同上；null 表示结束学习模式（会话本身不动） |
| sessions.list | {limit?} | 有模式的会话，最近设置的在前 |
| skills.list | — | [{name, kind: bundle\|file, description, whenToUse?, managed, valid}] |
| skills.get | {name} | 同上加 body |
| skills.create / skills.update | {name, description, whenToUse?, body}；update 省略的字段保持原值，whenToUse 传空串表示清除 | 同 skills.get |
| skills.delete | {name} | {deleted: true} |

skills.* 不打开学习库。

### 11.6 界面（M2）

设置 → 学习：新增「开始学习」（三种模式各一行）、「学习会话」（有模式的会话，可打开、左滑结束学习模式）、「在学习会话中使用学习记忆」开关、「我的 Skills」页（列出、新建、编辑、删除；不是这里建的显示「只读」，格式不对的显示「格式有误」）。只保证编译通过，没有人工看过。

## 12. 轻量知识库（M3）

### 12.1 分工
- **App（Swift）**：选文件（txt、Markdown、PDF）；txt/md 按 UTF-8（含 BOM）→ UTF-16（有 BOM）→ GB 18030 的顺序解码；PDF 用 PDFKit 逐页取文字层，取不到文字就是扫描件，界面显示「暂不支持」；一次最多 200 万字。可选的 OpenAI 兼容向量服务也在 App 里调用，Key 只存 Keychain。
- **引擎（Node，plugins/learning）**：分块（kb.mjs）、存储（学习库 v4）、关键词检索、向量比较、结果合并、引用格式；Apple 句向量通过 native/ios-native 的 `nlp.vectors` 在引擎里生成（embed.mjs），导入后在后台建立。
- **扫描件**：只定义了 `kb.parse.cloud` 接口（App 发 PDF 的 base64 和文件名），没有实现，固定返回 422 `unsupported`。

### 12.2 分块（参数见 DECISIONS.md D16）
- 先按句切：`。！？；…` 后、`. ! ? ;` 后跟空白处、换行处；句末的右引号、右括号留在本句。`3.14` 这类不切。
- 按句装块，目标 500、上限 800 码点；新块开头带上一块末尾的整句，合计不超过 80 码点；超过上限的单句在空格或逗号处硬切，切不开就按上限硬切（不会切开代理对）。
- Markdown：标题行另起一块；每块记标题路径（「第一章 › 1.1 极限」）。最后一块不足 40 码点且和前一块同一节时，并回前一块。
- `text.slice(start, end)` 就是这一块，start/end 是 UTF-16 偏移。

### 12.3 学习库 v4
- `kb_documents(id, title, kind txt|md|pdf, source_name, chars, chunk_count, language, embedding_status, created_at, updated_at)`
- `kb_chunks(id, document_id → ON DELETE CASCADE, ordinal, start, end, heading, text, UNIQUE(document_id, ordinal))` + `kb_chunks_fts`（trigram，可无，`meta.kb_fts`）
- `kb_vectors(chunk_id → ON DELETE CASCADE, model, dims, vector BLOB, PRIMARY KEY(chunk_id, model))`：float32 小端；同一 model 的维度固定，由第一次写入决定。
- 设置：`meta.kb_apple_embedding`（默认 on）。

### 12.4 检索
- 关键词：查询词都 ≥3 字且有 trigram 时用 FTS（bm25），否则 LIKE（同笔记规则），最多取 50 条。
- 向量：每个有向量的 model 各算一次余弦（只比同一 model 的向量），取 >0 的前 50 条。Apple 的 model 名是 `apple-nl-sentence/<语言>/r<修订号>`，所以不同语言、不同修订的向量互不比较；OpenAI 兼容服务是 `openai/<host>/<模型>`。
- 合并：关键词和各个向量排名用 RRF（k=60）合并；只依赖名次，不依赖分数大小（native 注释里实测过：Apple 句向量的余弦大小没有意义，顺序有意义）。
- 引用：每条结果带 documentId、documentTitle、chunkId、ordinal/chunkCount、start/end、heading、160 字摘录，以及 `label`：「《标题》第 n/N 段（标题路径）」。

### 12.5 接口（在 §9、§11.5 的基础上新增）
| 方法 | 参数 | 返回 |
|---|---|---|
| kb.status | — | {search, vectors:{chunks, models:[{model,dims,chunks}]}, appleEmbedding:{available, enabled}} |
| kb.documents.list / get / delete | get、delete 要 {id} | 文档对象 |
| kb.documents.import | {title, kind, text, sourceName?} | 文档对象；之后后台建 Apple 向量 |
| kb.chunks.get | {id} | 一块的全文和位置 |
| kb.vectors.pending | {model 或 modelPrefix, documentId?, limit?} | [{chunkId, text}] |
| kb.vectors.put | {model, items:[{chunkId, vector}]} | {stored, dims} |
| kb.vectors.clear / kb.vectors.index | {model} / — | {deleted} / {started} |
| kb.search | {query, queryVectors?:[{model, vector}], documentIds?, limit?} | {mode: fts\|like\|hybrid\|none, results:[引用…]} |
| kb.parse.cloud | {name, data} | 固定 422 unsupported（未实现） |

### 12.6 NLEmbedding 评估
- 怎么测：`DshIOSTests/KnowledgeAPITests.testEvaluateAppleSentenceEmbedding` 在 CI 的 iPhone 模拟器上跑，打印 `NLEMBED language=… available=… dimension=… revision=… near=… far=… order=…`（中文、英文各一组）。可用性和排序只记录、不判失败。
- 结论：【待 CI】结果出来后填在这里。模拟器上有，不等于真机有（真机可能要下载语言资源）【待真机】。

## 13. 题库测验与错题本（M4）

### 13.1 怎么出题、怎么判分
- 题目由模型生成：学习会话（有学习模式的会话）里，学习插件向模型提供工具 `learning_quiz`（`ctx.tools.register`，写法照 ios-voice-message；`when` 只对学习会话、非子智能体放行）。`learning-quiz` skill 要求模型出题前先 `save`、学习者作答后 `grade`。
- 判分在 Node（plugins/learning/quiz.mjs）：
  - 单选：读出答案里唯一的选项字母（"B"、"b."、"我选 C"、"(d)"），和保存的字母比；模型的判断不参与。
  - 简答：先比规范化后的全文（NFKC、小写、去空白和标点）；不相同就看参考答案的关键词（拉丁词和数字、中日韩相邻两字）有多少出现在作答里：≥0.7 答对、≥0.3 部分正确、否则答错（D20）。模型可以传自己的 `judged` 判定，传了就以它为准（gradedBy=model）；学习者在 App 里可以改判（gradedBy=user）。
- 题型：单选（2–6 个选项）和简答。一次最多保存 20 题，一批里有一题不合格就整批不存。

### 13.2 学习库 v5
- `quiz_questions(id, kind choice|short, prompt, options JSON, answer, explanation, topic, source model|user, session_id, created_at)`；单选的 answer 存字母。
- `quiz_attempts(id, question_id → CASCADE, answer, verdict correct|partial|incorrect, score, graded_by rule|model|user, created_at)`
- `quiz_mistakes(question_id PK → CASCADE, streak, added_at, updated_at)`

### 13.3 错题本规则
- 作答结果不是「答对」（包括部分正确）：题目进入错题本；已在本里的，连对次数清零。
- 本里的题答对一次连对 +1，连续答对 `MASTERY`（初值 2，D21）次后移出。不在本里的题答对，不变化。
- 判分、写作答记录、更新错题本在同一个事务里。

### 13.4 接口
| 方法 | 参数 | 返回 |
|---|---|---|
| quiz.questions.list | {topic?, mistakes?, limit?, offset?} | 题目（不含答案） |
| quiz.questions.get | {id, withAnswer?} | 题目（默认含答案和解析） |
| quiz.questions.create / delete | create 要 {questions}（source=user）；delete 要 {id} | |
| quiz.topics | — | [{topic, questions, mistakes}] |
| quiz.answer | {id, answer, judged?, gradedBy?: 'user'} | {verdict, score, gradedBy, chosen?, correctAnswer, explanation, mistakeBook: added\|in\|removed\|not-in, streak?, mastery} |
| quiz.attempts | {questionId, limit?} | 作答记录，新的在前 |

工具 `learning_quiz`：action = save（questions）/ grade（questionId, answer, judged?）/ list（topic?, mistakes?；不含答案）。

### 13.5 界面
设置 → 学习 →「题库与错题本」：错题本 / 全部题目切换、左滑删除、点开重做（单选点选项，简答输入），显示判定、参考答案、解析和错题本变化；简答可以「其实我答对了 / 答错了」改判。只保证编译通过。

## 14. Deep Research（M5，方案 C；取代 §10 的简化设计）

评估和选择理由：`.tmp/fp-control/评估_M5_DeepResearch.md`（不进仓库），结论记在 DECISIONS D23。

### 14.1 结构
主会话 → 随包 skill `deep-research`（何时用、先澄清范围、选深度、如何呈现报告）→ 学习插件的模型工具 `deep_research`（start/status/report/resume/cancel/list）→ ResearchRunner（research-tool.mjs）在一个归会话所有的 dsh-jobs job 里跑 → 研究引擎 research.mjs → 工具：ctx.web 的 search/fetch、学习库知识库检索（M3，含 Apple 向量）。模型用调用会话最近路由的 provider/model（`session.requestHeader().config`，写法同 dsh-compaction-basic），经 ctx.llm，凭据和 Fish Pocket 线路照常。

### 14.2 流程（每一步一个确定的 key）
1. `plan`：拆成 2/4/6 个子课题（quick/standard/deep）。
2. 每个子课题一个小循环（≤3/5/6 轮）：模型每轮回一个 JSON 动作 `search` / `fetch` / `kb` / `append`（新子课题进队列，相似度去重，队列上限 4/8/10）/ `finish`（带 `[CIT-…]` 的小结）。没用过工具不许 finish。每条检索结果一次 note 摘要（原文截 8000 字），记成一条引用。用尽轮数还没 finish 就强制小结。
3. 交叉验证：从所有小结里挑 ≤3/6/10 条关键结论 → 每条用结论原话做一次独立检索 → 模型判定 corroborated / single-source / conflicting / refuted；conflicting 自动生成一个「Conflicting evidence: …」子课题去查清。
4. 盲区检查：≤1/2/2 轮，模型对照大纲和小结提出至多 3 个新子课题，研究后再做一次验证。
5. 报告：大纲（每个块都要进某一节，漏掉的补「Other findings」）→ 各节（只用给定证据，标注单一来源/矛盾/推翻）→ 开头摘要 → 删除未知 CIT → 按首次出现编号 → 结论核查表 → 参考文献。
- 预算：模型调用硬上限 40/90/150；到了就停止扩展，报告照写（报告不计入上限）并在末尾说明。

### 14.3 落盘与恢复
- 学习库 v6：`research_jobs`（状态 planned/running/paused/done/failed/cancelled、phase、progress、cancel_requested、calls_used、model_target、report、error）、`research_blocks`、`research_steps(job_id, key, kind llm|tool|mark, output)`、`research_citations`、`research_claims`。
- 每次模型调用、工具调用的输出先按 key 写进 `research_steps`（主键 job_id+key），再往下走；续跑时同一 key 直接读回，不再调用。加块、加引用也以 step key 去重。所以在任意一步中断都能续跑，重复续跑不会写出第二份（测试在每一次调用处中断各验证一遍）。
- 引擎启动（学习库首次打开）时把 `running` 改成 `paused`；App 或模型 `resume` 后从最后完成的一步继续。
- 取消：置 `cancel_requested`，当前这一步做完后变 `cancelled`，已完成的步骤保留，不写报告。

### 14.4 接口
| 方法 | 参数 | 返回 |
|---|---|---|
| research.list | {limit?} | 任务（不含报告） |
| research.get | {id} | 任务（含报告） |
| research.claims | {id} | 结论核查 |
| research.resume | {id} | {started, reason?, job} |
| research.cancel / research.delete | {id} | 任务 / {deleted}；运行中的任务不能删 |
| settings.update | {researchWeb} | 研究是否联网（默认开，D24） |

### 14.5 iOS 运行
- 研究在引擎进程里跑，没有子进程、没有新依赖。dsh-jobs job 归会话所有，会话的 Agent 释放时 job 被取消，但所有已完成步骤都在学习库里，`resume` 接着做。
- 后台：App 在后台时靠 BackgroundKeeper（静音音频默认开）；被系统杀掉后靠续跑。PLAN §10 里设想的 BGProcessingTask 没有做（D26）。

### 14.6 界面
设置 → 学习 →「深度研究」：联网开关、任务列表、任务详情（状态、进度、结论核查、报告、分享、继续、停止、删除）。研究本身在会话里由模型发起。只保证编译通过。

## 15. 导出、备份、一键删除（M6）

只操作 `$DSH_HOME/learning/`（学习库、WAL、`exports/`、`backups/`），不碰 DSH 自己的文件、ds-bot 的数据、会话、「我的 Skills」。代码在 plugins/learning/portable.mjs。

### 15.1 导出与导入
- 导出写到 `learning/exports/learning-export-<时间>/`：`notes/<笔记本>/<笔记>.md`（文件名去掉 `/\:*?"<>|`，同名加「 (2)」）、`research/<主题>.md`（已完成的研究报告）、`data.json`（全部数据，内部 id 换成导出内的引用；知识库资料存还原后的全文；研究存报告、结论核查和来源，不存中间步骤）、`README.md`。App 用 ShareLink 分享或存到「文件」。
- 导入：读 data.json，只导入**空的**学习库（否则 409），一个事务，不合格就什么都不写；资料重新分块，向量之后重建。格式版本 `EXPORT_VERSION = 1`，比 App 新的拒绝。
- 测试：导出 → 导入到空库 → 两边 dump 完全相等。

### 15.2 备份与恢复
- 备份：`VACUUM INTO learning/backups/learning-<时间>.db`（一致的快照，WAL 中的数据也在），同一秒重名加 `-2`。
- 恢复：只接受 `backups/` 里列出的文件名；先检查 application_id 和 schema 版本（1..当前），再给当前库做一份安全备份，关闭学习库，替换文件，重新打开（旧版本备份会被迁移到当前版本）。研究运行中拒绝。

### 15.3 一键删除
- `data.delete` 必须带 `confirm: "delete-learning-data"`，研究运行中拒绝；关闭学习库后删除整个 `learning/` 目录，之后再打开就是空库。
- App 两次确认，第一次列出要删除和不会删除的内容（带数量）。
- 测试：在假 `$DSH_HOME` 里放 settings、会话、profiles、skills，删除后 `learning/` 不存在，其余文件逐字节不变（sha256）。

### 15.4 接口
| 方法 | 参数 | 返回 |
|---|---|---|
| data.summary | — | 各类数量 |
| data.export | — | {path, 各类数量} |
| data.import | {data} 或 {path} | {imported} |
| backup.create / backup.list | — | {path, name, bytes} / [{name, bytes}] |
| backup.restore | {name} | {restored, schemaVersion, previous} |
| data.delete | {confirm} | {deleted} |

### 15.5 界面
设置 → 学习 →「学习数据」：导出并分享、从 data.json 导入、立即备份、备份列表（点一下恢复）、删除全部学习数据（两次确认）。只保证编译通过。
