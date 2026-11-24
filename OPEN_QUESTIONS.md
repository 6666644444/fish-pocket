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

**需要你决定**：
- 接受默认用 `xcode-27`（预览镜像），还是等 macos-26 容量恢复后用上面的命令切回去？
- 如果之后 `xcode-27` 也拿不到机器，下一个备选是 `macos-latest`（正式镜像），但它的 Xcode 可能比本 App 要求的旧。上游注释说旧编译器会拒绝一段很长的 SwiftUI 代码，到时可能需要拆分那段代码。
