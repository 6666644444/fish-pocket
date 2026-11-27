import SwiftUI

// Learning mode in any chat (batch 2): a plain conversation keeps its own, a Bot's chat
// follows the Bot, a group chat follows the group and its admin teaches (engine
// plugins/learning/dsbot.mjs). The menu item and the bar above the composer share one cache.

/// Where a learning mode is kept.
enum LearningOwner: Hashable, Sendable {
    case session(String)
    case bot(String)
    case room(String)
}

/// A Bot's or a group's learning mode as the engine reports it (`owners.*`).
struct LearningOwnerStatus: Codable, Hashable, Sendable {
    struct Teacher: Codable, Hashable, Sendable {
        let id: String
        let name: String
    }

    /// "bot" or "room".
    let kind: String
    let id: String
    let mode: LearningMode?
    var name: String?
    /// A group's admin, who teaches.
    var teacher: Teacher?
    /// A group in a mode that has no admin now: nothing is given until one is set.
    var paused: Bool?
    var endedAt: Double?

    var endedDate: Date? { endedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var owner: LearningOwner { kind == "room" ? .room(id) : .bot(id) }
}

/// What a chat's menu and bar show.
struct LearningModeNow: Equatable, Sendable {
    var mode: LearningMode?
    /// A group's teacher (its admin).
    var teacher: String?
    var paused = false
    /// A group without an admin cannot start one.
    var needsAdmin = false
}

extension LearningClient {
    func ownerStatus(kind: String, id: String) async throws -> LearningOwnerStatus {
        try await call("owners.get", ["kind": .string(kind), "id": .string(id)])
    }

    @discardableResult
    func setOwnerMode(_ mode: LearningMode?, kind: String, id: String) async throws -> LearningOwnerStatus {
        try await call("owners.set", ["kind": .string(kind), "id": .string(id), "mode": mode.map { .string($0.rawValue) } ?? .null])
    }

    /// Bots and groups in a learning mode.
    func ownerModes() async throws -> [LearningOwnerStatus] { try await call("owners.list") }
    /// Bots and groups whose learning mode was ended.
    func ownerHistory() async throws -> [LearningOwnerStatus] { try await call("owners.history") }
    func hideOwner(kind: String, id: String) async throws {
        _ = try await call("owners.hide", ["kind": .string(kind), "id": .string(id)], as: JSON.self)
    }

    func now(of owner: LearningOwner) async throws -> LearningModeNow {
        switch owner {
        case .session(let id):
            return LearningModeNow(mode: try await mode(of: id)?.mode)
        case .bot(let id):
            return LearningModeNow(mode: try await ownerStatus(kind: "bot", id: id).mode)
        case .room(let id):
            let status = try await ownerStatus(kind: "room", id: id)
            return LearningModeNow(mode: status.mode, teacher: status.teacher?.name, paused: status.paused ?? false, needsAdmin: status.teacher == nil)
        }
    }

    func set(_ mode: LearningMode?, for owner: LearningOwner) async throws {
        switch owner {
        case .session(let id): try await setMode(mode, for: id)
        case .bot(let id): try await setOwnerMode(mode, kind: "bot", id: id)
        case .room(let id): try await setOwnerMode(mode, kind: "room", id: id)
        }
    }
}

/// The learning modes the open chats are in, as last read.
@MainActor
@Observable
final class LearningModes {
    static let shared = LearningModes()
    private(set) var now: [LearningOwner: LearningModeNow] = [:]

    func refresh(_ owner: LearningOwner, client: LearningClient) async {
        // Written only when it changed: every view that reads `now` is drawn again on a write.
        if let value = try? await client.now(of: owner), now[owner] != value { now[owner] = value }
    }

    /// Switch `owner` to `mode` (nil: back to normal), then read it again.
    func choose(_ mode: LearningMode?, for owner: LearningOwner, app: AppModel) {
        let client = LearningClient(engine: app.client)
        Task {
            do {
                try await client.set(mode, for: owner)
                Haptics.select()
                app.showToast(mode.map { String(localized: "已切换到\($0.title)，下一轮生效") } ?? String(localized: "已回到普通模式"))
            } catch {
                app.showToast(error.localizedDescription, tone: .warning)
            }
            await refresh(owner, client: client)
        }
    }
}

/// The choices: normal, then each mode, the current one ticked.
struct LearningModeOptions: View {
    let now: LearningModeNow
    let choose: (LearningMode?) -> Void

    var body: some View {
        Button { choose(nil) } label: {
            if now.mode == nil { Label("普通模式", systemImage: "checkmark") } else { Text("普通模式") }
        }
        ForEach(LearningMode.allCases) { mode in
            Button { choose(mode) } label: {
                if now.mode == mode { Label(mode.title, systemImage: "checkmark") } else { Text(mode.title) }
            }
            .disabled(now.needsAdmin && now.mode == nil)
        }
        if now.needsAdmin {
            Text("学习模式由群主当老师，先在群详情里设一位群主")
        } else if let teacher = now.teacher {
            Text("老师：\(teacher)（群主）")
        }
    }
}

/// 学习模式 in a chat's own menu.
struct LearningModeMenu: View {
    @Environment(AppModel.self) private var app
    let owner: LearningOwner

    var body: some View {
        let now = LearningModes.shared.now[owner] ?? LearningModeNow()
        Menu {
            LearningModeOptions(now: now) { LearningModes.shared.choose($0, for: owner, app: app) }
        } label: {
            Label("学习模式", systemImage: "graduationcap")
        }
    }
}

// Where a chat shows its mode without a row of its own (D50): a group's is a chip at the front of
// the @ row, a Bot's own chat has a small mark in its title. The teacher and the choices are in the
// menu. Nothing shows while no mode is on.

/// Keeps the cache fresh for a chat's menu, chip and mark: read when the chat opens and when a
/// group's admin changes.
struct LearningModeRefresh: ViewModifier {
    @Environment(AppModel.self) private var app
    let owner: LearningOwner

    private var key: String {
        if case .room(let id) = owner { return "room:\(id):\(app.botTeam.room(id)?.admin ?? "")" }
        return "\(owner)"
    }

    func body(content: Content) -> some View {
        content.task(id: key) { await LearningModes.shared.refresh(owner, client: LearningClient(engine: app.client)) }
    }
}

extension View {
    func learningModeRefresh(_ owner: LearningOwner) -> some View { modifier(LearningModeRefresh(owner: owner)) }
}

/// A group's mode, first in its @ row and drawn like the @ chips; a tap opens the choices.
struct LearningModeChip: View {
    @Environment(AppModel.self) private var app
    let owner: LearningOwner

    var body: some View {
        let now = LearningModes.shared.now[owner] ?? LearningModeNow()
        if let mode = now.mode {
            Menu {
                LearningModeOptions(now: now) { LearningModes.shared.choose($0, for: owner, app: app) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "book.closed.fill").font(.caption)
                    Text(now.paused ? String(localized: "已暂停") : mode.title)
                }
                .font(.footnote)
                .foregroundStyle(now.paused ? Color.orange : Palette.ink)
                .padding(.horizontal, 12).frame(minHeight: 30)
                .background(Palette.field, in: Capsule())
                .contentShape(Capsule())
            }
            .accessibilityLabel("学习模式")
            .accessibilityValue(mode.title)
            .accessibilityHint("切换学习模式")
        }
    }
}

/// A Bot's mode as a small mark in its chat's title; switched from the chat's 「…」 menu.
struct LearningModeMark: View {
    let owner: LearningOwner

    var body: some View {
        if let mode = LearningModes.shared.now[owner]?.mode {
            Image(systemName: "book.closed.fill")
                .font(.caption2)
                .foregroundStyle(Palette.secondary)
                .accessibilityLabel("学习模式")
                .accessibilityValue(mode.title)
        }
    }
}
