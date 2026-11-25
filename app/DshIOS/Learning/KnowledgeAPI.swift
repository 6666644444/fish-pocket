import Foundation
import PDFKit

// The knowledge base (milestone 3): engine/plugins/learning (kb.*). The engine chunks, stores
// and searches; Apple's sentence vectors are made inside the engine (native/ios-native
// `nlp.vectors`). This file adds what only the app can do: read a PDF's text layer with
// PDFKit, decode text files, and call an OpenAI-compatible embedding provider whose key
// stays in the Keychain and never reaches the engine.

struct KnowledgeDocument: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    let title: String
    /// "txt", "md" or "pdf".
    let kind: String
    let sourceName: String
    let chars: Int
    let chunkCount: Int
    /// BCP-47 code the engine detected for Apple's embedding; "" until then.
    let language: String
    /// "", "ok", "unavailable" (no Apple sentence embedding for the language), "failed".
    let embeddingStatus: String
    let createdAt: Double
    let updatedAt: Double
}

/// One search hit with its citation: document, chunk position, quoted text.
struct KnowledgeHit: Codable, Identifiable, Hashable, Sendable {
    let documentId: Int
    let documentTitle: String
    let chunkId: Int
    let ordinal: Int
    let chunkCount: Int
    let start: Int
    let end: Int
    let heading: String?
    let excerpt: String
    /// 《title》第 n/N 段（heading）
    let label: String
    let score: Double

    var id: Int { chunkId }
}

struct KnowledgeSearchResult: Codable, Sendable {
    /// "fts", "like", "hybrid" (keyword + vectors) or "none".
    let mode: String
    let results: [KnowledgeHit]
}

struct KnowledgeVectorModel: Codable, Hashable, Sendable {
    let model: String
    let dims: Int
    let chunks: Int
}

struct KnowledgeStatus: Codable, Sendable {
    struct Vectors: Codable, Sendable { let chunks: Int; let models: [KnowledgeVectorModel] }
    struct Apple: Codable, Sendable { let available: Bool; let enabled: Bool }
    let search: String
    let vectors: Vectors
    let appleEmbedding: Apple
}

struct KnowledgePending: Codable, Sendable { let chunkId: Int; let text: String }
struct KnowledgeStored: Codable, Sendable { let stored: Int; let dims: Int? }

extension LearningClient {
    func knowledgeStatus() async throws -> KnowledgeStatus { try await call("kb.status") }
    func documents() async throws -> [KnowledgeDocument] { try await call("kb.documents.list") }
    func importDocument(title: String, kind: String, text: String, sourceName: String) async throws -> KnowledgeDocument {
        try await call("kb.documents.import", [
            "title": .string(title), "kind": .string(kind), "text": .string(text), "sourceName": .string(sourceName),
        ])
    }
    func deleteDocument(_ id: Int) async throws {
        _ = try await call("kb.documents.delete", ["id": .number(Double(id))], as: LearningDeleted.self)
    }
    /// `queryVectors`: vectors the app made itself (an OpenAI-compatible provider), by model.
    func searchKnowledge(_ query: String, queryVectors: [(model: String, vector: [Float])] = [], limit: Int = 10) async throws -> KnowledgeSearchResult {
        var params: [String: JSON] = ["query": .string(query), "limit": .number(Double(limit))]
        if !queryVectors.isEmpty {
            params["queryVectors"] = .array(queryVectors.map { entry in
                .object(["model": .string(entry.model), "vector": .array(entry.vector.map { .number(Double($0)) })])
            })
        }
        return try await call("kb.search", params)
    }
    func pendingVectors(model: String, limit: Int = 32) async throws -> [KnowledgePending] {
        try await call("kb.vectors.pending", ["model": .string(model), "limit": .number(Double(limit))])
    }
    func putVectors(model: String, items: [(chunkId: Int, vector: [Float])]) async throws -> KnowledgeStored {
        try await call("kb.vectors.put", [
            "model": .string(model),
            "items": .array(items.map { item in
                .object(["chunkId": .number(Double(item.chunkId)), "vector": .array(item.vector.map { .number(Double($0)) })])
            }),
        ])
    }
    func setAppleEmbedding(_ on: Bool) async throws -> LearningSettings {
        try await call("settings.update", ["appleEmbedding": .bool(on)])
    }
}

// MARK: - Reading files

enum KnowledgeImportError: LocalizedError, Equatable {
    case unsupportedType(String)
    case unreadableText
    case tooLong(Int)
    case scannedPDF
    case unreadablePDF

    var errorDescription: String? {
        switch self {
        case .unsupportedType(let ext): String(localized: "暂不支持导入 .\(ext) 文件，请选择 txt、Markdown 或 PDF")
        case .unreadableText: String(localized: "无法识别这个文件的文字编码")
        case .tooLong(let count): String(localized: "文件太长（\(count) 字），一次最多导入 200 万字")
        case .scannedPDF: String(localized: "这个 PDF 没有文字层（可能是扫描件），暂不支持")
        case .unreadablePDF: String(localized: "无法打开这个 PDF")
        }
    }
}

enum KnowledgeFiles {
    /// What one import may hold, in characters; the engine allows more, but one request is
    /// a single JSON body and this keeps it modest.
    static let maxCharacters = 2_000_000

    /// "txt", "md" or "pdf" for a file name, or nil.
    static func kind(of fileName: String) -> String? {
        switch (fileName as NSString).pathExtension.lowercased() {
        case "txt", "text": "txt"
        case "md", "markdown": "md"
        case "pdf": "pdf"
        default: nil
        }
    }

    /// UTF-8 (with or without BOM), UTF-16 with BOM, then GB 18030 (most Chinese text files
    /// that are not UTF-8).
    static func decodeText(_ data: Data) -> String? {
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]) { return String(data: data, encoding: .utf16) }
        if let text = String(data: data, encoding: .utf8) {
            return text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text
        }
        let gb = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))
        return String(data: data, encoding: gb)
    }

    /// The text layer of a PDF, page by page. Empty when it has none (a scan).
    static func pdfText(_ document: PDFDocument) -> String {
        (0..<document.pageCount)
            .compactMap { document.page(at: $0)?.string?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    /// Title, kind and text of a file the user picked. Throws a message the screen can show.
    static func read(_ url: URL) throws -> (title: String, kind: String, text: String) {
        let name = url.lastPathComponent
        guard let kind = kind(of: name) else { throw KnowledgeImportError.unsupportedType(url.pathExtension) }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let text: String
        if kind == "pdf" {
            guard let document = PDFDocument(url: url) else { throw KnowledgeImportError.unreadablePDF }
            text = pdfText(document)
            if text.isEmpty { throw KnowledgeImportError.scannedPDF }
        } else {
            guard let data = try? Data(contentsOf: url), let decoded = decodeText(data) else { throw KnowledgeImportError.unreadableText }
            text = decoded
        }
        let count = text.unicodeScalars.count
        if count > maxCharacters { throw KnowledgeImportError.tooLong(count) }
        return ((name as NSString).deletingPathExtension, kind, text)
    }
}

// MARK: - OpenAI-compatible embedding provider

/// An OpenAI-compatible `/embeddings` endpoint. Base URL and model in UserDefaults; the key
/// in the Keychain, on this device only. Optional: Apple's embedding is the default.
struct EmbeddingProvider: Equatable, Sendable {
    var baseURL: String
    var model: String

    private static let baseKey = "learning.embedding.baseURL"
    private static let modelKey = "learning.embedding.model"
    static let keyAccount = "learning.embedding.apiKey"

    /// The configured provider, or nil when none is set up.
    static var current: EmbeddingProvider? {
        let defaults = UserDefaults.standard
        guard let base = defaults.string(forKey: baseKey), !base.isEmpty,
              let model = defaults.string(forKey: modelKey), !model.isEmpty else { return nil }
        return EmbeddingProvider(baseURL: base, model: model)
    }

    static func save(_ provider: EmbeddingProvider?) {
        let defaults = UserDefaults.standard
        defaults.set(provider?.baseURL, forKey: baseKey)
        defaults.set(provider?.model, forKey: modelKey)
    }

    /// The engine's name for this provider's vectors: host and model, so two providers or
    /// two models never share (and never compare) vectors.
    var engineModel: String {
        let host = URL(string: baseURL)?.host ?? baseURL
        return "openai/\(host)/\(model)"
    }

    var endpoint: URL? {
        guard var url = URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme == "https" else { return nil }
        if !url.path.hasSuffix("/embeddings") { url.appendPathComponent("embeddings") }
        return url
    }

    static func requestBody(model: String, texts: [String]) throws -> Data {
        try JSONEncoder().encode(JSON.object(["model": .string(model), "input": .array(texts.map { .string($0) })]))
    }

    /// The vectors in an `/embeddings` reply, in input order (`data[].index`).
    static func parse(_ data: Data, count: Int) throws -> [[Float]] {
        let reply = try JSON.parse(data)
        if let message = reply["error"]["message"].string { throw LearningError(kind: "transport", message: message, status: 0) }
        var out = [[Float]?](repeating: nil, count: count)
        for (position, item) in reply["data"].array.enumerated() {
            let index = item["index"].int ?? position
            guard index >= 0, index < count else { continue }
            out[index] = item["embedding"].array.compactMap { $0.double.map(Float.init) }
        }
        guard out.allSatisfy({ $0?.isEmpty == false }) else {
            throw LearningError(kind: "transport", message: String(localized: "向量服务的返回内容不完整"), status: 0)
        }
        return out.map { $0 ?? [] }
    }

    func embed(_ texts: [String]) async throws -> [[Float]] {
        guard let endpoint else { throw LearningError(kind: "invalid", message: String(localized: "向量服务的地址必须以 https:// 开头"), status: 0) }
        guard let key = LearningKeychain.read(Self.keyAccount), !key.isEmpty else {
            throw LearningError(kind: "invalid", message: String(localized: "还没有填写向量服务的 API Key"), status: 0)
        }
        var request = URLRequest(url: endpoint, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(key)", forHTTPHeaderField: "authorization")
        request.httpBody = try Self.requestBody(model: model, texts: texts)
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let message = (try? JSON.parse(data))?["error"]["message"].string ?? String(localized: "向量服务请求失败（HTTP \(status)）")
            throw LearningError(kind: "transport", message: message, status: status)
        }
        return try Self.parse(data, count: texts.count)
    }

    /// Embed every chunk that lacks this provider's vector, in batches.
    @discardableResult
    func indexPending(_ client: LearningClient, batch: Int = 32) async throws -> Int {
        var stored = 0
        while !Task.isCancelled {
            let pending = try await client.pendingVectors(model: engineModel, limit: batch)
            if pending.isEmpty { break }
            let vectors = try await embed(pending.map(\.text))
            stored += try await client.putVectors(model: engineModel, items: zip(pending, vectors).map { (chunkId: $0.chunkId, vector: $1) }).stored
        }
        return stored
    }
}

/// The learning features' secrets, kept in the Keychain on this device only.
enum LearningKeychain {
    private static var service: String { (Bundle.main.bundleIdentifier ?? "dsh-ios") + ".learning" }

    static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Store a value; nil removes it.
    static func write(_ account: String, _ value: String?) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var attributes = query
        attributes[kSecValueData as String] = Data(value.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(attributes as CFDictionary, nil)
    }
}
