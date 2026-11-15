import SwiftUI

/// The phone's 工具 tab: what gives the agent more to reach, beyond a conversation of its own —
/// plugins, connectors, the computers of remote control, phone control, the web version. On
/// iPad these are rows of the sidebar.
struct ToolsTabView: View {
    enum Route: Hashable { case plugins, connectors, remote, phoneControl }

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Binding var path: [Route]
    @State private var phoneControl = PhoneControlService()

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    row(.plugins, "插件", "puzzlepiece.extension", "发现、安装和管理插件")
                    row(.connectors, "连接器", "point.3.connected.trianglepath.dotted", "接入外部服务和本机能力", status: connectorStatus)
                } header: {
                    Text("扩展智能体")
                }
                Section {
                    row(.remote, "远程控制", "laptopcomputer.and.iphone", "在手机上管电脑里的智能体", status: remoteStatus,
                        warns: app.remote.expired)
                    row(.phoneControl, "操控手机", "hand.tap", "让智能体点按其他 App", status: phoneControl.state == .running ? String(localized: "运行中") : nil,
                        live: phoneControl.state == .running)
                } header: {
                    Text("控制设备")
                }
                Section {
                    // Opens over everything: the mark of the links that leave the page.
                    Button { Haptics.tap(); app.webRequest = UUID() } label: {
                        label("网页版", "globe", "插件自带的界面在这里打开") {
                            Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(Palette.ink)
                }
            }
            .navigationTitle("工具")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .plugins: PluginStoreView()
                case .connectors: BotConnectorsPage().settingsStyle()
                case .remote: RemoteControlPage().environment(\.systemLists, true)
                case .phoneControl: PhoneControlView().environment(\.systemLists, true)
                }
            }
            // The row says whether iCTRL runs; that changes while the user is in iCTRL.
            .task { await phoneControl.refresh() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await phoneControl.refresh() } }
            }
        }
    }

    /// Once signed in: computers online, offline, or the sign-in to renew. Before, the line under
    /// the name already says what it is for.
    private var remoteStatus: String? {
        let remote = app.remote
        return remote.signedIn || remote.expired ? DrawerView.remoteControlNote(remote) : nil
    }

    private var connectorStatus: String? {
        let team = app.botTeam
        let connected = team.status == .ready ? team.connectors.filter { $0["state"].string == "ready" }.count : 0
        return connected > 0 ? String(localized: "\(connected) 个已连接") : nil
    }

    private func row(_ route: Route, _ title: LocalizedStringKey, _ icon: String, _ detail: LocalizedStringKey,
                     status: String? = nil, warns: Bool = false, live: Bool = false) -> some View {
        NavigationLink(value: route) {
            label(title, icon, detail) {
                if let status {
                    HStack(spacing: 5) {
                        if live { Circle().fill(.green).frame(width: 7, height: 7) }
                        Text(status)
                    }
                    .font(.footnote)
                    .foregroundStyle(warns ? Palette.waiting : Palette.secondary)
                    .lineLimit(1)
                }
            }
        }
    }

    /// An icon on an ink tile, the name and a line on what it is for, and what it says on the right.
    private func label(_ title: LocalizedStringKey, _ icon: String, _ detail: LocalizedStringKey,
                       @ViewBuilder trailing: () -> some View) -> some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(Palette.onInk)
                .frame(width: 38, height: 38)
                .background(Palette.ink, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body).foregroundStyle(Palette.ink)
                Text(detail).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
            }
            // The name and its line first; a status that does not fit is what gives way.
            .layoutPriority(1)
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
