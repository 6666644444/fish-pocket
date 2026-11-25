# 决定记录（DECISIONS.md）

每条记录写明四件事：定了什么、为什么这么定、还考虑过哪些方案、要改回去怎么办。

## D1 技术分工：SQLite 和检索放在 Node（node:sqlite），Swift 只负责界面和系统能力（2026-11-25，M1）

- **定了什么**：学习库的读写、迁移、检索、各种状态机，都放在 `engine/plugins/learning/` 里，用 Node 24 自带的 `node:sqlite`。Swift 侧只负责界面、桥接，以及 PDFKit、Keychain、NLEmbedding、后台任务这些只有原生代码能做的事。
- **为什么**：
  - DSH 自己的会话检索（`@deepseek-ai/dsh-session-query-sqlite` 0.2.2-rc.4）就是 `import("node:sqlite")` 加 FTS5，用同一套东西最省事，也不用另起一套；
  - 如果把 SQL 放到 Swift，每次查询都要多走一层 JS↔Swift 的往返，还得新写一套绑定；
  - iOS 上 V8 很可能跑在 jitless 模式下，WASM（sql.js、wa-sqlite）不一定能用。
- **考虑过的其他方案**：
  - Swift 侧调用系统自带的 `libsqlite3`，通过一个窄桥只暴露 exec、query、事务三个原语，SQL 仍然由 Node 组装；
  - WASM 版 SQLite；
  - JSON 文件加原子写入。
- **要改回去怎么办**：`store.mjs` 是唯一出现 SQL 的地方，换后端只需要改这一个文件，接口不变。
- **现状**：node:sqlite 在 iPhone 模拟器的 NodeMobile 上能不能用，**还没有验证**（交给 M1 的模拟器检查，见 D5）。

## D2 学习库放在 `$DSH_HOME/learning/learning.db`（M1）

- **为什么**：
  - `engine/runtime/recovery.mjs` 的 `settingsFiles()` 会把 `$DSH_HOME` 根目录和 `profiles/web` 里所有不超过 1 MB 的文件都当成设置，启动时打检查点，「恢复」时回滚，「重置」时移走。把库放在下一层的子目录里，这几种操作就都碰不到它；
  - `Documents` 目录会被「文件」App 共享出去，所以也不能放那里。
- **测试**：`learning-store.test.mjs` 里的「the library lives where recovery never takes it for a setting」，直接断言 `settingsFiles()` 的结果里不包含学习库的任何文件。
- **考虑过的其他方案**：`DSH_IOS_DATA`（`/home/dsh/.ios`）。没选它，因为那是 App 和引擎之间交换小文件的目录。
- **要改回去怎么办**：改 `libraryFile()`，再写一次性的搬移逻辑。M1 不需要。

## D3 文件标识和版本（M1）

- `PRAGMA application_id = 0x4C524E31`（'LRN1'），和 DSH 会话检索用的 1146308689 不重复。schema 版本记在 `user_version` 里。
- 打开时遇到下面三种情况就拒绝，并且不改动文件：application_id 不是我们的；库里已经有表但不带 id；版本比当前代码新。
- 迁移按顺序执行，每一步只新增东西，不删、不重写。

## D4 中文检索：trigram FTS5，查询词有 1 到 2 个字时退回 LIKE（M1）

- **为什么**：
  - DSH 用的 `unicode61` 分词器会把一整段连续的中文当成一个词，中文基本搜不到；
  - trigram 能做任意子串匹配，但只认 3 个字及以上。本机 SQLite 3.54 实测：「函数的」能命中，「函数」返回空；
  - 所以只要有一个查询词少于 3 个字，整个查询就改用 `LIKE`（`%`、`_`、`\` 都会转义）。
- **如果 SQLite 不带 trigram**：迁移 v2 会在 `meta.fts` 里记成 `none`，之后全部走 LIKE。这条路径有测试覆盖，用 `fts: false` 跑同一组用例。
- **考虑过的其他方案**：自己在 JS 里做 bigram 分词再建倒排表；ICU 分词器（nodejs-mobile 是 small-icu，不一定有）。
- **参数**：查询词按空白切分，词与词之间是 AND 关系，最多取 8 个词。

## D5 CI：新增 ubuntu job，只跑 `learning-*.test.mjs`（M1）

- **为什么**：
  - 公开仓库用 Linux 机器免费，几分钟就能出结果；
  - 其他引擎测试是按 App 的 macOS/iOS 目录结构写的（路径、shell、git addon）。本机 Windows + Node 26 的基线结果是 229 个用例里 32 个失败，全部来自这些上游测试，和学习功能无关。在 Linux 上跑它们说明不了我们的改动对不对，反而会让 job 一直是红的。
- **固定 Node 版本**：用 `24.20`，和 nodejs-mobile 24.20.0 一致。本机是 Node 26，最终以 CI 的结果为准。
- **macOS job 上的 node:sqlite 和 trigram 检查**：放到 M1 的第二步（Swift 部分）再加，用一个独立的新脚本，不改上游的 `conformance.mjs`。
- **要改回去怎么办**：在 `ios-ci.yml` 里删掉 `engine-tests` 这个 job。

## D6 接口：插件自己注册路由 `/api/learning/<method>`（M1）

- 写法参照 `ios-voice-message` 和 `ios-speech`，用 `ctx.connection.fetch.register`，和引擎共用同一个端口和 cookie，不另起服务。
- 方法名统一用 `learning` 前缀，下面分 `notebooks.*`、`notes.*`、`memories.*`、`status`，完整清单见 `docs/PLAN.md` 第 9 节。
- 学习库在第一次收到请求时才打开，不在引擎启动时打开。这样它出问题不会拖住或者卡死引擎启动。

## D7 界面入口：设置页里新增一个「学习」分区（M1）

- **决定**：在设置页「插件 / 自动化」那个分区下面，新增一个只有一行「学习」的分区。点进去是「学习记忆」入口和笔记本列表。代码放在 `app/DshIOS/Learning/`。
- **理由**：不改任何已有的行和页面，对现有功能没有影响，也最容易和上游合并。首页的 Tab 结构比较复杂（自适应 Tab，iPad 和 Duo 上一共三种布局），风险更高。
- **替代方案**：在探索页加一张卡片，或者在首页加一个 Tab。等功能多起来、在真机上看过之后再考虑。
- **回退**：删掉 `SettingsView.swift` 里新增的那 5 行。
- **未验证**：界面外观和交互只保证能编译通过，还没在模拟器或真机上看过。

## D8 Swift 和 Node 之间的桥接（M1）

- `LearningAPI` 只负责格式，不发请求：请求路径、请求体编码、响应解码、错误转换都在这里，所以 XCTest 不用启动引擎就能测。`LearningClient` 用引擎的 session 发请求，cookie 也沿用引擎的。
- 错误统一转成 `LearningError(kind, message, status)`。HTTP 200 但返回的数据形状不对，也按传输错误处理，不会当成成功静默吞掉。

## D9 模拟器上的 SQLite 验证：新增脚本，不改上游的 conformance 测试（M1）

- 新增 `scripts/test-learning-sim.sh` 和 `native/root/test/learning-sqlite.mjs`，写法照 `test-root-sim.sh`：不启动 App，在模拟器里直接用真实的 NodeMobile 加文件系统视图，跑 node:sqlite、trigram 分词，以及插件 store 的中文检索。
- 放在 CI macOS job 的单元测试之后执行，限时 10 分钟。

## D10 翻译（M1）

- 新增 34 条文案，en、es、ja、ko、zh-Hant 五种语言都按 CLAUDE.md「界面翻译」的要求逐条直接翻译，没有用简繁转换工具。zh-Hant 用台湾用词（儲存、裝置、搜尋、新增、建立）。
- 改法是在 `Localizable.xcstrings` 的 `strings` 末尾插入文本，文件其余部分一个字节都没动。以后 Xcode 同步时可能会重新排序，不影响结果。
- `scripts/strings-coverage.mjs` 结果：五种语言都是 3631/3631。

## D11 学习模式用随包 skill 加每轮注入，不用 Agent 预设（2026-11-25，M2）

- 查过的结论：
  - **skill 能直接复用**：`dsh-skill-filesystem` 已经从 `engine/skills`（随包根，rank 600）和 `$DSH_HOME/skills`（用户根，rank 400）加载 skill，格式是 `<name>/SKILL.md` 加 YAML 头（必填 `name`、`description`，可选 `whenToUse`、`metadata` 等），目录有监视，不用重启。
  - **Agent 预设不适合**：`dsh-agent-preset-registry` 不扫描目录，新增预设要往 profile 里装一份 bundle patch；用户一旦覆盖某个预设，会替换整份子插件列表，以后上游对它的修改也合不进来。为了三段提示词去改 profile，风险比收益大。
- 做法：三种模式写成三个随包 skill（learning-qa / learning-socratic / learning-quiz），学习插件在 `agent/pre-step` 里把模式说明注入学习会话（写法照 ios-call 的通话提示）。同一份 SKILL.md 既是注入的来源，也能在任何会话里 `/名称` 调用，只有一份文本。
- 注入只给学习库里记了模式的会话。普通会话一律原样通过，不改变现有功能的行为（总控第四节）。

## D12 模式说明只完整注入一次，之后每轮一行提醒（M2）

- 完整说明每轮都放会让长会话的上下文越来越大（每份 1.3–1.8 KB）。所以一个会话第一次进入某个模式时放完整正文，之后只放一行提醒，提醒里告诉模型看不到说明时去加载对应的 skill（会话被压缩后也能找回来）。
- `announced` 存在学习库里，引擎重启后不会重复完整注入。

## D13 学习记忆注入的参数初值（M2）

- 最多 3 条；每条最多 300 字；合计最多 800 字；剩余不到 40 字就不再加；只在最近更新的 500 条里挑。
- 相关度用「拉丁词 + 中日韩相邻两字」的 token 重合度，不用向量：M3 之前学习库里还没有 embedding，而且这样在 Node 里就能测。
- 没有任何一条相关时补 1 条最近更新的，让「我在准备考研」这类长期信息也能进来；有 3 条相关时不补。
- 默认开启；设置里关掉后只是不再附记忆，模式说明照常。设置存在学习库的 `meta` 表，不放在 `$DSH_HOME` 根目录（那里的文件会被当成设置，见 D2）。

## D14 自定义 Skills 放 DSH 自己的用户 skill 目录，只改这里建的（M2）

- 目录：`$DSH_HOME/skills/<name>/SKILL.md`，不另建一套。它在 `$DSH_HOME` 下一层，`recovery.mjs` 不会把它当设置。
- 这个目录里原来可能就有用户或 Agent 写的 skill。按总控第四节「不读写已有用户数据」，这些只列出和查看，不改不删；这里建的在 `metadata` 里带 `created-by: dsh-learning`，只有带标记的才能编辑和删除。删除时文件夹里有 SKILL.md 以外的文件就拒绝。
- 名字规则直接用 `@deepseek-ai/dsh-skill` 的 `isSkillName`；`learning-` 前缀保留给随包模式，避免用户 skill（rank 400）盖住随包的（rank 600）。description 最多 500 字，因为 dsh-tool-skill 在目录里只显示前 500 字。
- YAML：只写不读复杂结构，值一律写成 JSON 字符串（YAML 能读的双引号标量）。没有引入 YAML 库（`yaml` 包是 ISC 许可，按总控第四节不新增）；测试里用 node_modules 里已有的 `yaml`（dsh-skill-filesystem 的依赖）核对 DSH 能解析我们写出的文件，App 代码不依赖它。
- 这次测试抓到一个问题：随包 SKILL.md 的 description 里有 `": "`，YAML 会解析失败，DSH 会静默跳过这个 skill。已改成带引号的写法，测试会拦住同类问题。

## D15 学习会话怎么建（M2）

- 用 App 现成的 `AppModel.createSession(in:)`（会复用一个空白会话，和「新会话」按钮一样），再调 `sessions.setMode`。没有改会话列表或聊天界面。
- 已知限制：学习会话建好后如果一条消息都没发，之后点普通的「新会话」可能会复用它，这时它仍在学习模式里。设置 → 学习 → 学习会话里可以结束学习模式。记在 OPEN_QUESTIONS.md 第 7 条。

## D16 知识库分块参数（2026-11-25，M3）

- 初值：目标 500、上限 800、重叠 ≤80、最小尾块 40，都按 Unicode 码点算（kb.mjs `CHUNKING`）。
- 理由：中文 500 字大约一两段，检索时既能命中细节又带上下文；800 的上限让一次检索带 8 条结果时合计约 6000 字，进提示词不至于太大。重叠只放整句，避免半句话被两边各切一半。
- 中文按句号、问号、叹号、分号、省略号切；英文只在标点后跟空白时切，所以 `3.14`、`e.g.x` 不会被切开。

## D17 向量谁来算：Apple 的在引擎里，OpenAI 兼容的在 App 里（M3）

- Apple 句向量：在 native/ios-native 的 `nlp` 里加一个 `vectors` 操作（最小改动：一个函数加能力表里的一个名字），引擎用它给文档和查询算向量。这样 Deep Research（M5）在引擎里也能直接做语义检索，不用绕回 App。模型工具 `text_analysis` 不提供这个操作（模型用不上原始向量）。
- OpenAI 兼容服务：只在 App 里调用，Key 只存 Keychain、不交给引擎；App 取 `kb.vectors.pending`、算好后 `kb.vectors.put`，搜索时把查询向量放进 `queryVectors`。代价：M5 在引擎里用不了这个服务，只能用 Apple 向量和关键词。
- 向量按 model 分开存、分开比：model 名里带语言和修订号（Apple）或 host 和模型名（OpenAI 兼容），不同 model 的向量从不互相比较。

## D18 默认检索方案：关键词 + Apple 句向量，用 RRF 合并（M3）

- 默认开启 Apple 句向量：不联网、不要 Key、不花钱；设备没有该语言的句向量时这份资料只按关键词检索（`embedding_status = unavailable`，不反复重试）。
- 合并用 RRF（k=60）只看名次：native/ios-native 里的实测注释说明 Apple 句向量的余弦大小没有可比性（正确答案 0.10、无关 -0.32），名次才可靠。
- 关键词检索始终在：向量缺失、关闭或出错时，结果退化成纯关键词，不会没有结果。
- 这是在 NLEmbedding 中文效果还没测到之前的选择；评估结果见 PLAN.md §12.6，结果不好就把默认改成只用关键词。

## D19 NLEmbedding 中文评估怎么做（M3）

- 不在 Node 测（桌面没有 NaturalLanguage）。用 XCTest 在 CI 的 iPhone 模拟器上测中文、英文各一组：是否有句向量、维度、修订号、相关句和无关句的距离顺序，打印成 `NLEMBED …` 行。可用性和顺序只记录不判失败：这是评估，不是功能测试。
- 只算「CI：模拟器」结论。真机可能需要下载语言资源，标【待真机】。

## 改过的上游文件

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `engine/ios.patch.yml` | 只在 `insert` 末尾追加了 `learning` 一项，已有条目没动 | 注册学习插件 |
| `.github/workflows/ios-ci.yml` | 新增 `engine-tests` job，以及 macOS job 里的「Learning SQLite on NodeMobile」这一步（这个文件是 fork 自己加的，不是上游的） | 见 D5、D9 |
| `docs/PLAN.md` | 从仓库根目录挪进来（git mv），然后补充内容 | fork 自己的文档 |
| `app/DshIOS/Views/SettingsView.swift` | 新增一个 5 行的分区 | 见 D7 |
| `app/Shared/Localizable.xcstrings` | 在末尾追加 34 条（M1），M2 再追加 34 条 | 见 D10；M2 同样五种语言逐条翻译，覆盖率 3665/3665 |
| `native/ios-native/caps_nlp.m` | M3：新增 `vectors` 函数和分发里的一行，已有操作没动 | 见 D17 |
| `native/ios-native/ios_native.m` | M3：能力表 `nlp` 一行里加了 `"vectors"` | 见 D17 |
| `native/root/test/learning-sqlite.mjs` | M3：加一项知识库检查（这是 fork 自己加的文件） | 模拟器上验证 v4 表、trigram、float32 向量 |

没有改：`node_modules`、引擎版本、`ios.patch.yml` 里已有的条目、`ios-build.yml`、`LICENSE`、`project.yml`、Bundle ID、App Group、签名、`test-root-sim.sh`、`conformance.mjs`。

## 新增的依赖

无。
