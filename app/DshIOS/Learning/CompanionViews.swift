import SwiftUI
import UIKit
import UserNotifications

// Firefly 伙伴 (D55): one Bot the user chose becomes a long-term companion. The engine keeps the
// shared experiences, what it has come to know of the user and how they have been
// (engine/plugins/learning/companion*.mjs); here the user picks the Bot, sees and corrects what is
// kept, and the app schedules the notification for the companion speaking first: the phone's
// engine is asleep in the background, so the plan is made as the app leaves and the message is
// said in the chat when it comes back.

struct CompanionSettings: Codable, Hashable, Sendable {
    var botId: String
    var reach: Bool
    var quietStart: Int
    var quietEnd: Int
    /// D56: each group's admin is a companion in its group too.
    var groupAdmins: Bool?
    /// D56: what ta said in private may come to mind in a group.
    var groupRecallDm: Bool?
}

struct CompanionTrait: Codable, Hashable, Identifiable, Sendable {
    var botId: String?
    let key: String
    let text: String
    let evidence: String
    let days: [Double]
    let firstSeen: Double
    let lastSeen: Double
    let refuted: Bool
    var id: String { "\(botId ?? ""):\(key)" }
}

struct CompanionMood: Codable, Hashable, Sendable {
    let word: String
    let valence: Double
    let at: Double
}

struct CompanionEpisode: Codable, Hashable, Identifiable, Sendable {
    let id: Int
    var botId: String?
    let text: String
    let cues: [String]
    let importance: Double
    let mood: String
    let followUp: String
    let happenedAt: Double
    let recalls: Int
    let supersededBy: Int?
    let hidden: Bool
    /// "dm" or "room:<id>".
    var scope: String?
}

struct CompanionReach: Codable, Hashable, Sendable {
    let id: Int
    let botId: String
    let fireAt: Double
    let text: String
    let status: String
    var botName: String?
    /// A group's admin posting in its group (D56).
    var roomId: String?
    var roomName: String?
    /// The chat a tap opens: the Bot's own, or the group's.
    var sessionId: String?
}

struct CompanionStatus: Codable, Sendable {
    let settings: CompanionSettings
    let botName: String?
    let traits: [CompanionTrait]
    let mood: CompanionMood?
    let episodes: Int
    let planned: CompanionReach?
}

struct CompanionPlan: Codable, Sendable {
    let plan: CompanionReach?
    let skip: String?
}

struct CompanionWake: Codable, Sendable {
    let delivered: [Int]
    let expired: [Int]
    let cancelled: [Int]
}

extension LearningClient {
    func companionStatus() async throws -> CompanionStatus { try await call("companion.status") }
    func setCompanion(_ params: [String: JSON]) async throws -> CompanionSettings { try await call("companion.settings.set", params) }
    func companionEpisodes(all: Bool = false) async throws -> [CompanionEpisode] { try await call("companion.episodes", ["all": .bool(all)]) }
    func hideEpisode(_ id: Int, hidden: Bool = true) async throws {
        struct Done: Codable { let hidden: Bool }
        _ = try await call("companion.episodes.hide", ["id": .number(Double(id)), "hidden": .bool(hidden)], as: Done.self)
    }
    func companionTraits() async throws -> [CompanionTrait] { try await call("companion.traits") }
    func refuteTrait(_ key: String, botId: String?) async throws {
        struct Done: Codable { let refuted: Bool }
        var params: [String: JSON] = ["key": .string(key)]
        if let botId { params["botId"] = .string(botId) }
        _ = try await call("companion.traits.refute", params, as: Done.self)
    }
    func planReach(allowed: Bool) async throws -> CompanionPlan {
        try await call("companion.plan", ["tzOffset": Self.tzOffset, "allowed": .bool(allowed)])
    }
    func wakeCompanion() async throws -> CompanionWake { try await call("companion.wake", ["tzOffset": Self.tzOffset]) }
}

/// The notification for the companion speaking first, and what a tap on it opens.
@MainActor
enum CompanionNotifications {
    static let prefix = "firefly-companion-"

    /// Before the first window: a tap on a notification that launches the app reaches the delegate.
    static func install() {
        UNUserNotificationCenter.current().delegate = CompanionNotificationDelegate.shared
    }

    static func allowed() async -> Bool {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional
    }

    /// The app is leaving: plan (the engine decides, at most one waiting) and schedule it.
    /// A background task holds the few seconds the opener may take to write.
    static func leaving(_ client: LearningClient) {
        let hold = BackgroundHold()
        Task { @MainActor in
            defer { hold.end() }
            let ok = await allowed()
            guard let plan = try? await client.planReach(allowed: ok).plan, ok else { return }
            await schedule(plan)
        }
    }

    static func schedule(_ reach: CompanionReach) async {
        let center = UNUserNotificationCenter.current()
        let id = prefix + String(reach.id)
        if await center.pendingNotificationRequests().contains(where: { $0.identifier == id }) { return }
        let wait = reach.fireAt / 1000 - Date.now.timeIntervalSince1970
        guard wait > 30 else { return }
        let content = UNMutableNotificationContent()
        let name = reach.botName?.isEmpty == false ? reach.botName! : "Firefly"
        content.title = reach.roomName.map { "\(name) · \($0)" } ?? name
        content.body = reach.text
        content.sound = .default
        content.threadIdentifier = "firefly-companion"
        // A group's post opens the group (its own Session routes to it); the chat opens the Bot's.
        let link: DshLink = reach.roomId != nil ? reach.sessionId.map(DshLink.session) ?? .bot(reach.botId) : .bot(reach.botId)
        content.userInfo = ["link": link.url.absoluteString]
        try? await center.add(UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false)))
    }

    /// The app is in front: what is due is said in the chat; what was called off leaves the phone.
    static func back(_ client: LearningClient) async {
        guard let wake = try? await client.wakeCompanion() else { return }
        let ids = (wake.delivered + wake.expired + wake.cancelled).map { prefix + String($0) }
        guard !ids.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
}

/// A few seconds of background time, ended once (by the work or by the system).
@MainActor
private final class BackgroundHold {
    private var id: UIBackgroundTaskIdentifier = .invalid

    init() {
        id = UIApplication.shared.beginBackgroundTask(withName: "firefly-companion") { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// Opens the companion's chat from its notification; shows its banner even over the app.
final class CompanionNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = CompanionNotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard response.notification.request.identifier.hasPrefix(CompanionNotifications.prefix),
              let link = (info["link"] as? String).flatMap(URL.init(string:)).flatMap(DshLink.init(url:)) else { return }
        await MainActor.run { DshIntentBridge.open?(link) }
    }

    /// Its own banner shows over the app too; every other notification behaves as with no delegate.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        notification.request.identifier.hasPrefix(CompanionNotifications.prefix) ? [.banner, .sound, .list] : []
    }
}

/// 设置 › 学习 › AI 伙伴.
struct CompanionPage: View {
    @Environment(AppModel.self) private var app
    @State private var status: CompanionStatus?
    @State private var episodes: [CompanionEpisode] = []
    @State private var traits: [CompanionTrait] = []
    @State private var loadError: String?
    @State private var notificationsAllowed = true

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            if let status {
                botSection(status)
                groupSection(status)
                if !status.settings.botId.isEmpty || status.settings.groupAdmins != false {
                    reachSection(status)
                    knowSection(status)
                    episodesSection
                }
            } else if let loadError {
                Text(loadError).font(.footnote).foregroundStyle(.red)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .groupedList()
        .navigationTitle("AI 伙伴")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        notificationsAllowed = await CompanionNotifications.allowed()
        do {
            status = try await client.companionStatus()
            episodes = try await client.companionEpisodes()
            traits = try await client.companionTraits()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func set(_ params: [String: JSON]) async {
        do {
            _ = try await client.setCompanion(params)
            await load()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func botSection(_ status: CompanionStatus) -> some View {
        Section {
            Picker("伙伴", selection: Binding(
                get: { status.settings.botId },
                set: { id in Task { await set(["botId": .string(id)]) } }
            )) {
                Text("不使用").tag("")
                ForEach(app.botTeam.bots) { bot in Text(verbatim: bot.name).tag(bot.id) }
            }
        } footer: {
            Text("选一个 Bot 作为长期伙伴。它的单聊和它在的群里都会生效：慢慢记住你们一起经历的事和你的习惯，在合适的时候自然想起，不会每句话都翻旧账。它原本的性格和 Bot 记忆不变。")
        }
    }

    /// D56: groups.
    private func groupSection(_ status: CompanionStatus) -> some View {
        Section {
            Toggle(isOn: Binding(
                get: { status.settings.groupAdmins != false },
                set: { on in Task { await set(["groupAdmins": .bool(on)]) } }
            )) {
                Label("群主也像朋友一样", systemImage: "person.2.wave.2")
            }
            Toggle(isOn: Binding(
                get: { status.settings.groupRecallDm == true },
                set: { on in Task { await set(["groupRecallDm": .bool(on)]) } }
            )) {
                Label("群里也能想起私聊的事", systemImage: "lock.open")
            }
        } header: {
            Text("群聊")
        } footer: {
            Text("群主在群里会记住大家一起聊过的事，说话像朋友，也可能在你最近去过的群里先开口；群开着学习模式时只保留语气，不提往事，不打乱出题和批改。你选的伙伴 Bot 进群也还是它自己。私聊里的事默认不在群里提。")
        }
    }

    /// A memory's Bot and place, as a row says it.
    private func origin(botId: String?, scope: String?) -> String {
        let name = botId.flatMap { app.botTeam.bot($0)?.name } ?? ""
        guard let scope, scope.hasPrefix("room:") else { return name }
        let room = app.botTeam.room(String(scope.dropFirst(5))).map { app.botTeam.name(of: $0) } ?? String(localized: "群聊")
        return name.isEmpty ? room : "\(name) · \(room)"
    }

    private func reachSection(_ status: CompanionStatus) -> some View {
        Section {
            Toggle(isOn: Binding(
                get: { status.settings.reach },
                set: { on in
                    Task {
                        if on, !notificationsAllowed {
                            notificationsAllowed = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                        }
                        await set(["reach": .bool(on)])
                    }
                }
            )) {
                Label("主动找我", systemImage: "bubble.left.and.text.bubble.right")
            }
            if status.settings.reach {
                Stepper(value: Binding(get: { status.settings.quietStart }, set: { v in Task { await set(["quietStart": .number(Double((v + 24) % 24))]) } }), in: -1...24) {
                    LabeledContent("安静时段开始") { Text(verbatim: String(format: "%02d:00", status.settings.quietStart)) }
                }
                Stepper(value: Binding(get: { status.settings.quietEnd }, set: { v in Task { await set(["quietEnd": .number(Double((v + 24) % 24))]) } }), in: -1...24) {
                    LabeledContent("安静时段结束") { Text(verbatim: String(format: "%02d:00", status.settings.quietEnd)) }
                }
                if let planned = status.planned {
                    LabeledContent("下一次") {
                        Text(Date(timeIntervalSince1970: planned.fireAt / 1000), format: .dateTime.month().day().hour().minute())
                    }
                }
            }
        } footer: {
            if status.settings.reach && !notificationsAllowed {
                Text("通知没有打开，它没法主动找你。可以在系统设置里给 Firefly 打开通知。")
            } else {
                Text("每天最多一次（单聊和群加起来），安静时段不打扰，你刚聊过不会马上又找你；连续不回就会少找你，你一回来就恢复。离开 App 时决定要不要找、在哪找、什么时候找，到时用通知提醒：伙伴在单聊里找你，或者群主在你最近去过的群里开口。你先回来聊天，这次就取消。")
            }
        }
    }

    @ViewBuilder
    private func knowSection(_ status: CompanionStatus) -> some View {
        Section {
            if let mood = status.mood {
                LabeledContent("你最近的状态") {
                    Text(verbatim: mood.word)
                }
            }
            if traits.isEmpty {
                Text("还没有。它要在不同的日子里多次看到，才会把一点印象当成对你的了解。").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(traits) { trait in
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: trait.text).foregroundStyle(trait.refuted ? .secondary : .primary)
                    HStack(spacing: 8) {
                        let from = origin(botId: trait.botId, scope: nil)
                        if !from.isEmpty { Text(verbatim: from) }
                        Text(verbatim: trait.key)
                        Text("看到过 \(trait.days.count) 天")
                        if trait.refuted { Text("你说不对") } else if trait.days.count < 2 { Text("还只是印象") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                .swipeActions {
                    if !trait.refuted {
                        Button("不对") { Task { try? await client.refuteTrait(trait.key, botId: trait.botId); await load() } }.tint(.orange)
                    }
                }
            }
        } header: {
            Text("它对你的了解")
        } footer: {
            Text("左滑「不对」，它就不再这样认为，除非以后又多次看到。")
        }
    }

    private var episodesSection: some View {
        Section {
            if episodes.isEmpty {
                Text("还没有。聊完一段停 20 分钟左右，它会把值得记住的事整理成回忆；大多数闲聊不会留下。").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(episodes) { episode in
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: episode.text)
                    HStack(spacing: 8) {
                        let from = origin(botId: episode.botId, scope: episode.scope)
                        if !from.isEmpty { Text(verbatim: from) }
                        Text(Date(timeIntervalSince1970: episode.happenedAt / 1000), format: .dateTime.month().day().hour().minute())
                        if !episode.mood.isEmpty { Text(verbatim: episode.mood) }
                        if episode.recalls > 0 { Text("想起过 \(episode.recalls) 次") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                .swipeActions {
                    Button("忘了它", role: .destructive) {
                        Task {
                            try? await client.hideEpisode(episode.id)
                            episodes.removeAll { $0.id == episode.id }
                        }
                    }
                }
            }
        } header: {
            Text("你们一起经历的事")
        } footer: {
            Text("越久越淡，重要的、常被想起的淡得慢；不会自动删除。左滑「忘了它」，它就不会再想起。也可以直接在聊天里跟它说「这件事别记了」。")
        }
    }
}
