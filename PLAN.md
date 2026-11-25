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
- **结论**：学习功能不能另起一个 Node，必须跑在 DSH 同一个引擎进程里，做成 DSH 插件。真要隔离重活（比如大批量建索引），可以用 `node:worker_threads`。真机一致性测试 `native/root/test/conformance.mjs` 已经覆盖了 Worker。

## 2. 能否使用原生 Node 模块；SQLite 放在哪一侧

- **原生模块**：不能用 `dlopen` 加载 `.node` 文件，App Store 也不允许动态加载未随 App 签名的代码。仓库的做法是把 C/ObjC 代码直接编进 App，再用 `napi_module_register` 注册成「链接绑定」，JS 侧通过 `process._linkedBinding('名字')` 调用。现有的绑定有 `dsh_git`、`dsh_image`、`dsh_ios_native`、`dsh_root`、`dsh_python`、`dsh_ffmpeg`，见 `native/*` 和 `app/project.yml` 的 sources。npm 上带预编译 `.node` 的包（better-sqlite3、sqlite3 等）在 iOS 上都不能用。【代码】
- **SQLite：放 Node 侧，用内置的 `node:sqlite`**，不放 Swift 侧，也不用 WASM。理由：
  - Node 24 自带 `node:sqlite`，不需要任何原生模块。
  - 真机一致性测试 `conformance.mjs` 第 111–124 行，已经在真的 NodeMobile 上测过 `DatabaseSync` 的 DELETE 和 WAL 两种日志模式。【代码】
  - DSH 自己的会话全文检索 `@deepseek-ai/dsh-session-query-sqlite` 就用 `node:sqlite` 加 FTS5。它是 `dsh-base` 的依赖，学习功能用同一套技术栈，最符合「复用、不另起一套」。【代码】
  - 放 Swift 侧的话，每次查询都要多走一层 JS↔Swift 通信，还要新写一套绑定。用 WASM（sql.js、wa-sqlite）则更慢、包更大，而且和 DSH 用的不是同一个 SQLite。
- **待确认**：
  - nodejs-mobile 编进去的 SQLite 带不带 FTS5，以及中文检索要用的 `trigram` 分词器。DSH 的会话检索用了 FTS5，说明大概率带，但具体分词器名在本地看不到，没有核实。【待真机】
  - 第 1 个里程碑会加一个 CI 能跑的检查：在模拟器上的 App 进程里执行 `create virtual table … using fts5(tokenize='trigram')`。如果不支持，就退回到 unicode61 分词器加 LIKE 查询。

## 3. 向量相似度放 Swift（Accelerate）还是 Node

- **现状**：`native/ios-native/caps_nlp.m` 用 `NLEmbedding sentenceEmbeddingForLanguage:` 和 `distanceBetweenString:andString:` 按语义排序，向量只在 ObjC 侧使用，不交给 JS。仓库里还没有用过 Accelerate。【代码】
- **结论：向量由 Swift/ObjC 生成，相似度在 Node 里算。**
  - 生成向量必须在原生侧，`NLEmbedding` 只有系统框架里才有。做法是在 `dsh_ios_native` 里加一个返回向量的方法（`vectorForString:`），以 `Float32Array` 交给 JS。
  - 向量以 BLOB 形式存进上面那个 SQLite，和文本块放在一起。
  - 相似度用 JS 写一个循环算点积或余弦。学习资料的规模大约是几千个文本块乘几百维，一次查询是百万次乘加，在 JS 里是毫秒级，不值得为它新建一条原生通道。
  - 只有当真机实测查询超过约 50 ms 时，才考虑在原生侧加 Accelerate（`vDSP_dotpr`）批量计算，同时在 project.yml 加上 Accelerate.framework。
- **待确认**：NLEmbedding 句向量的维度，以及中文是否可用。中文句向量可能没有，或要下载语言资源，所以要准备退路，比如用 DSH 已配置的在线 embedding 接口，或者只做关键词检索。【待真机】

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
