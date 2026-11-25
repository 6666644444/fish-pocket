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
}
