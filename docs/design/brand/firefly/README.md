# Firefly 图标

这个分支（只供个人使用）的主图标，替换了上游的「大肥鱼」主图标（DECISIONS.md D32）。

- `firefly-source-night.png`：用户 2026-11-25 选定的原图（剪纸风，夜空、月亮般的大圆、黄外套红围巾的小人举着星星棒）。
- `firefly-icon-dawn.png`：在原图上只调颜色：天空下半部换成从深蓝到杏色、淡金的黎明渐变（保留纸条接缝和纸纹），大圆调成更金的朝阳，太阳边和小人头边的深色纸影改成柔和的影子。人物、构图都没动。寓意「熬过黑夜，迎来天亮」，陪高考。
- 用到的地方：
  - `app/DshIOS/Assets.xcassets/AppIcon.appiconset/AppIcon.png`（= firefly-icon-dawn.png）
  - `AppIcon-Dark.png`：同一张图整体压暗 12%，深色模式主屏幕用
  - `AppIcon-Tinted.png`：灰度并拉开对比，iOS「着色」图标模式用
  - `app/Watch/Assets.xcassets/AppIcon.appiconset/AppIcon.png`（同主图标）
  - `app/DshIOS/Assets.xcassets/AppIconPreview/Default.imageset/Default.png`（180×180，设置 → App 图标 页里的预览，也用在「关于」等处的小图标）

这张图不是上游的吉祥物，不受 `../LICENSE` 里吉祥物 CC BY-NC-SA 4.0 的约束；上游的其他备选图标（樱花粉、贴纸、鲸鱼、字标等）原样保留，仍可在 设置 → App 图标 里切换。
