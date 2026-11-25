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

## 改过的上游文件

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `engine/ios.patch.yml` | 只在 `insert` 末尾追加了 `learning` 一项，已有条目没动 | 注册学习插件 |
| `.github/workflows/ios-ci.yml` | 新增 `engine-tests` job，以及 macOS job 里的「Learning SQLite on NodeMobile」这一步（这个文件是 fork 自己加的，不是上游的） | 见 D5、D9 |
| `docs/PLAN.md` | 从仓库根目录挪进来（git mv），然后补充内容 | fork 自己的文档 |
| `app/DshIOS/Views/SettingsView.swift` | 新增一个 5 行的分区 | 见 D7 |
| `app/Shared/Localizable.xcstrings` | 在末尾追加 34 条 | 见 D10 |

没有改：`node_modules`、引擎版本、`ios.patch.yml` 里已有的条目、`ios-build.yml`、`LICENSE`、`project.yml`、Bundle ID、App Group、签名、`test-root-sim.sh`、`conformance.mjs`。

## 新增的依赖

无。
