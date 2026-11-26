# 待确认问题

## 1. CI 机型 macos-26 连续三次没有机器接单（2026-11-24）

**现象**：`.github/workflows/ios-ci.yml` 按要求设成 `runs-on: macos-26`。第一次推送触发的运行（run 45429710410）连续三次都排队约 15 分钟后失败，没有执行任何步骤：

- Attempt 1：15:48Z 触发，排队 15m1s 后失败
- Attempt 2：16:04Z 重跑，排队 15m2s 后失败
- Attempt 3：16:19Z 重跑，排队约 15 分钟后失败

三次的注解完全一样：

```
X The job was not acquired by Runner of type hosted even after multiple attempts
- Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.
```

**判断**：问题出在 GitHub 托管 macOS arm64 机器的容量上，和代码、工作流内容无关。job 没被机器接走，所以没有日志，`gh run view --log-failed` 输出为空；排队时间不算 macOS 分钟。

**绕过方案（最保守）**：
- 默认机型改成 `xcode-27`。上游 `ios-build.yml` 用的就是它，上游仓库今天 02:09Z 的运行能正常拿到机器并成功，本 App 的代码在上游也是用这套 Xcode 编译的。
- 机型改为读仓库变量：`runs-on: ${{ vars.IOS_CI_RUNNER || 'xcode-27' }}`。想切回 macos-26 时，不用改代码：
  ```
  gh variable set IOS_CI_RUNNER -R 6666644444/fish-pocket --body macos-26
  ```
- 仍然不使用任何 `-xlarge` 机型。

**后续**：改用 xcode-27 后，CI 已经全绿（run 45459095743，5 个单元测试全部通过）。xcode-27 偶尔也要排队超过 15 分钟，重跑一次就能拿到机器。

**已决定（2026-11-24，用户）**：默认用 xcode-27；每个里程碑开工时查一次 macos-26，恢复了就用上面的命令切回去。

**补充（2026-11-25）**：macos-26 有机器了，可还是不能切回去。run 45554899599（ddea0fd，手动触发，当时 `IOS_CI_RUNNER=macos-26`）分到了 `macos-26-arm64` 镜像，上面带的是 **Xcode 26.6**。上游代码 `app/DshIOS/Call/CallSynthesizer.swift:208` 在这个版本下编译不过（`closure captures 'socket' before it is declared`），和学习功能的改动无关。变量已经改回 `xcode-27`。所以要切回 macos-26，除了有机器，还得确认镜像里有 Xcode 27（日志「Xcode」那一步会打印版本）。

原来的问题：
- 接受默认用 `xcode-27`（预览镜像），还是等 macos-26 容量恢复后用上面的命令切回去？
- 如果之后 `xcode-27` 也拿不到机器，下一个备选是 `macos-latest`（正式镜像），但它的 Xcode 可能比本 App 要求的旧。上游注释说旧编译器会拒绝一段很长的 SwiftUI 代码，到时可能需要拆分那段代码。

## 2. 新 App 的名称和图标（2026-11-24）

要求是不能出现「DeepTutor」字样。LICENSE 第 3 条又规定，修改版要用自己的名称和图标，不能用「Fish Pocket」的名称、图标和吉祥物（吉祥物按 CC BY-NC-SA 4.0 授权）。

**状态（2026-11-24，用户）**：暂不决定。开发期间沿用原来的显示名和图标，现有的 Bundle ID 和 App Group 一律不改（见第 6 条）。

**需要你决定**：新的 App 名称（中英文）和图标方向。

在定下来之前，开发分支保留原来的显示名和图标，只供你自己装机使用。发布前必须换掉；代码里的标识用中性的 `learning`，不带任何品牌名。

## 3. 公开 fork 是否算「公开分发修改版」（2026-11-24）

为了让 CI 的 macOS 分钟免费，代码推到了公开 fork `6666644444/fish-pocket`。

LICENSE 附加条款允许「为了向原仓库提 PR 而 fork」。但第 2 条要求：公开分发修改版之前，先在原仓库开 issue。条款列举的分发方式是应用商店、TestFlight、可下载的构建包，没有提到公开源码。CI 不产出可下载的 App，上传的只有失败时的测试结果包，保留 5 天。所以我判断风险较低，但条款没有写明。

**已决定（2026-11-24，用户）**：保持公开，由用户到原仓库开说明 issue。链接拿到后填进 NOTICE 的「授权来源」一栏，在此之前这一栏留空。

原来的选项：
- 保持现状；
- 在原仓库开一个说明 issue；
- 或者改成私有仓库。私有仓库的 macOS 分钟按 10 倍计费，按现在每次 CI 约 28 分钟算，免费额度大约只够跑 7 次。

## 4. 学习库要不要从 iCloud 备份里排除（2026-11-25）

学习库在 `~/.dsh/learning/learning.db`，现在按系统默认处理，会进 iCloud 或电脑备份。备份的好处是换手机也能带走；坏处是会占用户的 iCloud 空间，学习内容也会离开这台设备，进到用户自己的 Apple 备份里。

**需要你决定**：保持默认（会备份），还是给这个目录加上 `isExcludedFromBackup`？没有你的答复之前保持默认。

## 5. 将来改名时 Bundle ID 和 App Group 的迁移方案（2026-11-25，只有方案，没有动手）

现在的标识是 `com.wsw.dsh-ios`（以及各扩展）和 `group.com.wsw.dsh-ios`。改掉之后，系统会把它当成一个新 App：拿到全新的数据容器和 Keychain，旧数据都看不到。

建议方案：新 App 第一次启动时，如果发现没有数据，提示用户先在旧 App 里用「数据导出」（M6）导出，再在新 App 里导入。不要尝试跨 App 直接读取旧容器，iOS 不允许这样做。Keychain 里的 API Key 需要用户重新填一遍。

**需要你决定**：真正改名之前确认这个方案。现在什么都不改。

## 6. 签名、TestFlight、App Store（2026-11-25）

这些都不做。上 TestFlight 之前要满足 LICENSE 第 2、3 条：先在原仓库开 issue，并换成自己的名称、图标、Bundle ID 和吉祥物。另外，FFmpeg 采用的 LGPL 和 App Store 条款是否兼容，需要单独评估。

## 7. 没发过消息的学习会话可能被「新会话」复用（2026-11-25，M2）

学习会话用 App 现成的 `createSession` 建立。它和「新会话」按钮一样，会复用一个还没发过消息的空白会话。所以如果在「开始学习」里建了会话却一条消息都没发，之后点普通的「新会话」可能会拿到这个会话，它仍处在学习模式。

现在的处理：设置 → 学习 →「学习会话」里列出所有学习会话，左滑可以结束学习模式。没有改会话列表或「新会话」的逻辑，因为那会改变现有功能的行为（总控第四节）。

**需要你决定**：是否接受这个限制；如果不接受，可以考虑在聊天界面显示当前学习模式，或者让「新会话」跳过学习会话，这两种都要改上游的界面代码。

## 8. 引导式学习「不直接给答案」只靠提示词（2026-11-25，M2）

learning-socratic 要求模型不说出最终答案，学习者明确要求两次才给。这只是提示词约束，没有程序检查，模型可能做不到。CI 里没有真实模型，无法验证效果，需要人工试用（见 汇报_里程碑2.md 的人工验证步骤）。


## 9. GitHub Actions 对本仓库停用，M6、M7 的 CI 没有跑（2026-11-25）

- 从 `430aea0`（M6）起推送的 `430aea0`、`956bd55`、`ae33f5f`、`3b6897e` 都没有产生任何 workflow run；新加的 `upstream-check.yml` 也没有被 GitHub 登记。
- 手动触发 `gh workflow run ios-ci.yml` 返回 `HTTP 422: Actions has been disabled for this repository.`；但仓库的 Actions 设置读出来是 `enabled: true`，GitHub 状态页显示 Actions 正常。所以看起来是 GitHub 在平台一侧停用了这个仓库或账号的 Actions，不是仓库设置。
- 编码代理不去改仓库或账号设置。需要维护者到 GitHub 查看：仓库 Settings → Actions，以及账号邮箱里是否有 GitHub 发来的说明（例如 Actions 用量、账单或审核）。恢复后重新推送或在 Actions 页面手动运行 iOS CI，即可补跑 M6、M7。
- 最后一次全绿的 CI：run 45668381916（`fe211a2`，M5）。M6、M7 只在本机跑过 Node 测试（learning-* 120/120，全量失败数等于基线）。
