import Foundation

// The learning plugin's routes (engine/plugins/learning): `POST /api/learning/<method>` with
// the parameters as a JSON object, answered with `{ ok: true, result }` or
// `{ error: { kind, message } }` and a matching HTTP status. docs/PLAN.md §9 lists them.
// The shapes below mirror engine/plugins/learning/store.mjs; times are milliseconds.

struct LearningNotebook: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var title: String
    var noteCount: Int
    let createdAt: Double
    var updatedAt: Double
}

struct LearningNote: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    let notebookId: Int
    var title: String
    var body: String
    let createdAt: Double
    var updatedAt: Double
}

struct LearningSearchHit: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    let notebookId: Int
    let title: String
    let excerpt: String
    let updatedAt: Double
}

struct LearningSearchResult: Codable, Sendable {
    /// "fts" (trigram index), "like" (scan, for words under three characters), "none" (empty query).
    let mode: String
    let results: [LearningSearchHit]
}

/// One of the learner's long-term memories. Not a Bot's memory (ds-bot's MEMORY.md).
struct LearningMemory: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    var content: String
    /// "user" or "agent".
    let source: String
    let createdAt: Double
    var updatedAt: Double
}

struct LearningStatus: Codable, Sendable {
    let schemaVersion: Int
    let latestSchemaVersion: Int
    /// "trigram" or "none".
    let search: String
}

struct LearningDeleted: Codable, Sendable { let deleted: Bool }
struct LearningCleared: Codable, Sendable { let deleted: Int }

// Milestone 2: learning modes, the memory-injection setting, the user's own skills.

/// The three learning modes. Each is a skill that ships with the engine
/// (engine/skills/learning-<mode>/SKILL.md); a session started in one is told its instructions.
enum LearningMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case qa, socratic, quiz

    var id: String { rawValue }
    var skill: String { "learning-\(rawValue)" }

    var title: String {
        switch self {
        case .qa: String(localized: "普通问答")
        case .socratic: String(localized: "引导式学习")
        case .quiz: String(localized: "出题测验")
        }
    }

    var summary: String {
        switch self {
        case .qa: String(localized: "直接回答你的问题，讲清楚原因，再问一句确认你听懂了。")
        case .socratic: String(localized: "一次只问一个问题，一步步带你自己想出答案，不直接给答案。")
        case .quiz: String(localized: "一次出一道题（单选或简答），批改并讲解，最后给出小结。")
        }
    }

    var systemImage: String {
        switch self {
        case .qa: "questionmark.bubble"
        case .socratic: "figure.walk"
        case .quiz: "checklist"
        }
    }
}

struct LearningSettings: Codable, Equatable, Sendable {
    /// Whether learning sessions get a few relevant learning memories each turn.
    var injectMemories: Bool
}

/// A session the app started in a learning mode. Only the DSH session id is kept.
struct LearningSessionMode: Codable, Hashable, Sendable {
    let sessionId: String
    let mode: LearningMode
    let updatedAt: Double
}

/// One skill in `$DSH_HOME/skills`, the folder DSH loads the user's skills from.
struct LearningSkill: Codable, Identifiable, Hashable, Sendable {
    let name: String
    /// "bundle" (`<name>/SKILL.md`) or "file" (`<name>.md`).
    let kind: String
    let description: String
    let whenToUse: String?
    /// Created on the Skills page, so it can be edited and deleted there. Others are read-only here.
    let managed: Bool
    /// Has the frontmatter DSH needs; an invalid one is skipped by DSH.
    let valid: Bool
    /// Only in `skills.get`.
    let body: String?

    var id: String { name }
}

enum LearningSkillRules {
    /// The engine's rule (dsh-skill isSkillName): lowercase letters and digits in words joined by single hyphens.
    static func isValidName(_ name: String) -> Bool {
        guard !name.isEmpty, name.count <= 64, !name.hasPrefix("learning-") else { return false }
        return name.range(of: #"^[a-z0-9]+(-[a-z0-9]+)*$"#, options: .regularExpression) != nil
    }
}

/// What a learning route refused, or why it could not be reached.
struct LearningError: LocalizedError, Equatable, Sendable {
    /// The plugin's kind (invalid, not-found, conflict, unavailable, internal), or "transport".
    let kind: String
    let message: String
    let status: Int

    var errorDescription: String? { message }
}

/// The wire format, without any networking, so it can be tested on its own.
enum LearningAPI {
    static func path(_ method: String) -> String { "api/learning/\(method)" }

    static func body(_ params: [String: JSON]) throws -> Data {
        try JSONEncoder().encode(JSON.object(params))
    }

    static func decode<T: Decodable>(_ type: T.Type, data: Data, status: Int) throws -> T {
        guard let reply = try? JSON.parse(data) else {
            throw LearningError(kind: "transport", message: String(localized: "学习数据返回了无法解析的响应（HTTP \(status)）"), status: status)
        }
        if status == 200, reply["ok"].bool == true {
            do {
                return try reply["result"].decode(T.self)
            } catch {
                throw LearningError(kind: "transport", message: String(localized: "学习数据的格式和 App 不一致"), status: status)
            }
        }
        let error = reply["error"]
        throw LearningError(
            kind: error["kind"].string ?? "transport",
            message: error["message"].string ?? String(localized: "学习数据请求失败（HTTP \(status)）"),
            status: status
        )
    }
}

/// Calls the learning routes over the engine's session (its cookie, its origin).
struct LearningClient: Sendable {
    let engine: EngineClient

    func call<T: Decodable>(_ method: String, _ params: [String: JSON] = [:], as type: T.Type = T.self) async throws -> T {
        var request = engine.request(engine.origin.appendingPathComponent(LearningAPI.path(method)))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try LearningAPI.body(params)
        request.timeoutInterval = 30
        let (data, response) = try await engine.session.data(for: request)
        return try LearningAPI.decode(T.self, data: data, status: (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    func notebooks() async throws -> [LearningNotebook] { try await call("notebooks.list") }
    func createNotebook(title: String) async throws -> LearningNotebook {
        try await call("notebooks.create", ["title": .string(title)])
    }
    func renameNotebook(_ id: Int, title: String) async throws -> LearningNotebook {
        try await call("notebooks.update", ["id": .number(Double(id)), "title": .string(title)])
    }
    func deleteNotebook(_ id: Int) async throws {
        _ = try await call("notebooks.delete", ["id": .number(Double(id))], as: LearningDeleted.self)
    }

    func notes(in notebookId: Int) async throws -> [LearningNote] {
        try await call("notes.list", ["notebookId": .number(Double(notebookId)), "limit": 200])
    }
    func note(_ id: Int) async throws -> LearningNote { try await call("notes.get", ["id": .number(Double(id))]) }
    func createNote(in notebookId: Int, title: String, body: String) async throws -> LearningNote {
        try await call("notes.create", ["notebookId": .number(Double(notebookId)), "title": .string(title), "body": .string(body)])
    }
    func updateNote(_ id: Int, title: String, body: String) async throws -> LearningNote {
        try await call("notes.update", ["id": .number(Double(id)), "title": .string(title), "body": .string(body)])
    }
    func deleteNote(_ id: Int) async throws {
        _ = try await call("notes.delete", ["id": .number(Double(id))], as: LearningDeleted.self)
    }
    func search(_ query: String, in notebookId: Int?) async throws -> LearningSearchResult {
        var params: [String: JSON] = ["query": .string(query)]
        if let notebookId { params["notebookId"] = .number(Double(notebookId)) }
        return try await call("notes.search", params)
    }

    func memories() async throws -> [LearningMemory] { try await call("memories.list", ["limit": 200]) }
    func addMemory(_ content: String) async throws -> LearningMemory {
        try await call("memories.create", ["content": .string(content), "source": "user"])
    }
    func updateMemory(_ id: Int, content: String) async throws -> LearningMemory {
        try await call("memories.update", ["id": .number(Double(id)), "content": .string(content)])
    }
    func deleteMemory(_ id: Int) async throws {
        _ = try await call("memories.delete", ["id": .number(Double(id))], as: LearningDeleted.self)
    }
    /// Clears the learning memory only; notes and Bot memory stay.
    func clearMemories() async throws -> Int {
        try await call("memories.clear", as: LearningCleared.self).deleted
    }

    func settings() async throws -> LearningSettings { try await call("settings.get") }
    func setInjectMemories(_ on: Bool) async throws -> LearningSettings {
        try await call("settings.update", ["injectMemories": .bool(on)])
    }

    func sessionModes() async throws -> [LearningSessionMode] { try await call("sessions.list", ["limit": 200]) }
    func mode(of sessionId: String) async throws -> LearningSessionMode? {
        try await call("sessions.getMode", ["sessionId": .string(sessionId)], as: LearningSessionMode?.self)
    }
    /// Put a session in `mode`, or take it out of learning with nil (the conversation itself stays).
    @discardableResult
    func setMode(_ mode: LearningMode?, for sessionId: String) async throws -> LearningSessionMode? {
        try await call(
            "sessions.setMode",
            ["sessionId": .string(sessionId), "mode": mode.map { .string($0.rawValue) } ?? .null],
            as: LearningSessionMode?.self
        )
    }

    func skills() async throws -> [LearningSkill] { try await call("skills.list") }
    func skill(_ name: String) async throws -> LearningSkill { try await call("skills.get", ["name": .string(name)]) }
    func createSkill(name: String, description: String, whenToUse: String, body: String) async throws -> LearningSkill {
        try await call("skills.create", [
            "name": .string(name), "description": .string(description), "whenToUse": .string(whenToUse), "body": .string(body),
        ])
    }
    func updateSkill(name: String, description: String, whenToUse: String, body: String) async throws -> LearningSkill {
        try await call("skills.update", [
            "name": .string(name), "description": .string(description), "whenToUse": .string(whenToUse), "body": .string(body),
        ])
    }
    func deleteSkill(_ name: String) async throws {
        _ = try await call("skills.delete", ["name": .string(name)], as: LearningDeleted.self)
    }
}
