import SwiftUI

// Firefly (D54): the Bot page on a cold launch. ds-bot answers only once the engine has started
// and loaded its plugins, a few seconds in which the page used to show 「正在准备…」. The team as
// the app last saw it is kept in Caches and listed meanwhile, dimmed and not tappable (a chat
// needs the plugin); the live list takes over as soon as ds-bot answers.

/// The last team read, trimmed to what the list shows.
enum BotTeamPreview {
    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appending(path: "bot-team-preview.json")
    }

    static func read() -> JSON {
        guard let url, let data = try? Data(contentsOf: url) else { return .null }
        return (try? JSON.parse(data)) ?? .null
    }

    /// Called with each new team; written off the main thread.
    static func save(_ team: JSON) {
        let kept: JSON = .object([
            "bots": team["bots"],
            "rooms": team["rooms"],
            "mainBotIds": team["mainBotIds"],
        ])
        guard let url, let data = try? JSONEncoder().encode(kept) else { return }
        Task.detached(priority: .utility) {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}

struct BotPreviewList: View {
    @Environment(AppModel.self) private var app

    /// Whether there is a list to show.
    static func shows(_ team: BotModel) -> Bool {
        !team.preview["bots"].array.isEmpty || !team.preview["rooms"].array.isEmpty
    }

    var body: some View {
        let team = app.botTeam
        let bots = team.preview["bots"].array.map(BotInfo.init).filter { !$0.hidden }
        let rooms = team.preview["rooms"].array.map(RoomInfo.init).filter { !$0.hidden }
        let entries = (bots.map(BotListEntry.bot) + rooms.map(BotListEntry.room)).sorted(by: team.listOrder)
        List {
            Section {
                ForEach(entries) { entry in
                    row(entry, bots: bots)
                }
            } header: {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("正在连接 Bot…")
                }
                .font(.footnote)
                .foregroundStyle(Palette.secondary)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        // Rows are plain: nothing to open until ds-bot answers. Scrolling still works.
        .accessibilityHint(Text("正在连接 Bot…"))
    }

    @ViewBuilder
    private func row(_ entry: BotListEntry, bots: [BotInfo]) -> some View {
        HStack(spacing: 12) {
            switch entry {
            case .bot(let bot):
                BotAvatar(bot: bot, size: 44)
                BotRowText(title: bot.name, line: bot.role.isEmpty ? .none : .text(bot.role))
                if bot.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Palette.faint) }
            case .room(let room):
                RoomAvatar(room: room, size: 44)
                BotRowText(title: name(of: room, bots: bots), line: room.preview.map { .text($0) } ?? .none)
                if room.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Palette.faint) }
            }
        }
        .padding(.vertical, 4)
        .opacity(0.6)
    }

    /// As `BotModel.name(of:)`, from the kept Bots: the live team is not there yet.
    private func name(of room: RoomInfo, bots: [BotInfo]) -> String {
        guard !room.named else { return room.name }
        let members = room.members.compactMap { id in bots.first { $0.id == id }?.name }
        guard !members.isEmpty else { return room.name }
        return ([String(localized: "你")] + members).joined(separator: String(localized: "、"))
    }
}
