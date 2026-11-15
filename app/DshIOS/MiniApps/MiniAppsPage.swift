import SwiftUI

/// 我的应用: the small tools and games the agent made, as icons on a grid. They run on this
/// phone only, each on its own.
struct MiniAppsPage: View {
    /// The phone's 应用 tab, under a large title; otherwise a sheet with its close button.
    var asTab = false
    @State private var store = MiniAppStore.shared
    @State private var deleting: MiniApp?
    @State private var guide: MiniApp?
    @Environment(\.scenePhase) private var scenePhase

    private let columns = [GridItem(.adaptive(minimum: 76, maximum: 96), spacing: 12, alignment: .top)]

    var body: some View {
        Group {
            if store.loaded && store.apps.isEmpty {
                empty
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 20) {
                        ForEach(store.apps) { app in
                            Button { open(app) } label: { tile(app) }
                                .buttonStyle(.plain)
                                .contextMenu { menu(app) }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
                    Text("应用只在这台设备上运行，彼此隔离，读不到你的文件和对话，可以联网。")
                        .font(.footnote)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.vertical, 28)
                }
                .refreshable { store.refresh() }
            }
        }
        .background(Palette.background)
        .navigationTitle(asTab ? Self.tabTitle : String(localized: "我的应用"))
        .toolbarTitleDisplayMode(asTab ? .large : .inline)
        .toolbar {
            // A sheet's close button is on the right: there the new app goes on the left.
            ToolbarItem(placement: asTab ? .topBarTrailing : .topBarLeading) {
                Button { create() } label: { Image(systemName: "plus") }
                    .accessibilityLabel("做一个应用")
            }
        }
        .onAppear { store.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { store.refresh() } }
        .sheet(item: $guide) { app in SheetStack { MiniAppHomeScreenGuide(app: app) } }
        .confirmationDialog("删除「\(deleting?.name ?? "")」？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除应用", role: .destructive) {
                guard let app = deleting else { return }
                Task { await store.delete(app) }
            }
        } message: {
            Text("应用的文件和它保存的数据都会删除，无法恢复。")
        }
    }

    /// The 应用 tab's name and title.
    static var tabTitle: String {
        String(localized: "tab.apps", defaultValue: "应用", comment: "Tab and page title: the user's own mini apps")
    }

    private func tile(_ app: MiniApp) -> some View {
        VStack(spacing: 6) {
            MiniAppIcon(icon: app.icon, color: app.color, size: 60)
            Text(app.name).font(.caption).foregroundStyle(Palette.ink).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func menu(_ app: MiniApp) -> some View {
        Button("打开", systemImage: "arrow.up.forward.app") { open(app) }
        Button("让 Agent 修改", systemImage: "wand.and.stars") { ask(MiniAppPresenter.editDraft(app)) }
        Button("添加到主屏幕", systemImage: "plus.square.on.square") { guide = app }
        Divider()
        Button("删除", systemImage: "trash", role: .destructive) { deleting = app }
    }

    private var empty: some View {
        ContentUnavailableView {
            Label("还没有应用", systemImage: "square.grid.2x2")
        } description: {
            Text("在对话里让 Agent 做个小工具或小游戏，比如「做个记账本」，做好后会出现在这里。")
        } actions: {
            Button("做一个应用") { create() }
                .buttonStyle(.borderedProminent)
                .tint(Palette.ink)
                .foregroundStyle(Palette.onInk)
        }
    }

    private func open(_ app: MiniApp) {
        Haptics.tap()
        MiniAppPresenter.open(app.id)
    }

    private func create() {
        ask(String(localized: "帮我做一个小应用："))
    }

    /// A new conversation with `draft` in the composer; the shell closes this sheet to show it.
    private func ask(_ draft: String) {
        LinkInbox.shared.request = LinkRequest(link: .new(draft: draft))
    }
}

/// An app's icon: its emoji on its color, in the home screen's shape.
struct MiniAppIcon: View {
    let icon: String
    let color: String
    let size: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
            .fill(Color(miniApp: color).gradient)
            .frame(width: size, height: size)
            .overlay { Text(verbatim: icon).font(.system(size: size * 0.5)) }
            .accessibilityHidden(true)
    }
}

/// A reply's link to an app on a line of its own (`[记账本](fishapp://ledger)`), as a card that
/// opens it.
struct MiniAppCard: View {
    let id: String
    let title: String
    @State private var app: MiniApp?
    @State private var looked = false

    /// The id, when `paragraph` is nothing but a link to an app.
    static func linkedApp(_ paragraph: String) -> (id: String, title: String)? {
        let text = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = text.wholeMatch(of: /\[([^\]\n]+)\]\(fishapp:\/\/([a-z0-9-]+)\/?\)/) else { return nil }
        return (String(match.output.2), String(match.output.1))
    }

    var body: some View {
        Button {
            Haptics.tap()
            MiniAppPresenter.open(id)
        } label: {
            HStack(spacing: 12) {
                MiniAppIcon(icon: app?.icon ?? MiniApp.defaultIcon, color: app?.color ?? MiniApp.defaultColor, size: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text(app?.name ?? title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                    Text(looked && app == nil ? String(localized: "应用已删除") : app?.summary ?? String(localized: "我的应用"))
                        .font(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
                }
                Spacer(minLength: 0)
                if app != nil {
                    Text("打开")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.onInk)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(Palette.ink, in: Capsule())
                }
            }
            .padding(12)
            .background(Palette.field, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(looked && app == nil)
        .task(id: id) {
            app = MiniAppStore.shared.app(id)
            looked = true
        }
    }
}
