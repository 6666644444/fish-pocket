import SwiftUI
import UniformTypeIdentifiers

// Settings → 学习 → 学习数据 (milestone 6): export, import, backup and restore, and deleting all
// learning data. Only the learning library's folder ($DSH_HOME/learning) is touched; DSH,
// Bots, conversations and skills are not. Engine: engine/plugins/learning/portable.mjs.

struct LearningDataSummary: Codable, Equatable, Sendable {
    let notebooks: Int
    let notes: Int
    let memories: Int
    let documents: Int
    let questions: Int
    let mistakes: Int
    let research: Int
}

struct LearningExport: Codable, Sendable {
    /// The export folder, as the engine sees it (`/home/dsh/.dsh/learning/exports/…`).
    let path: String
    let notebooks: Int
    let notes: Int
    let memories: Int
    let documents: Int
    let questions: Int
    let research: Int
}

struct LearningBackup: Codable, Identifiable, Hashable, Sendable {
    let name: String
    let bytes: Int
    var id: String { name }
}

struct LearningRestored: Codable, Sendable {
    let restored: String
    let schemaVersion: Int
    let previous: String?
}

extension LearningClient {
    func dataSummary() async throws -> LearningDataSummary { try await call("data.summary") }
    func exportData() async throws -> LearningExport { try await call("data.export") }
    /// Import the contents of an export's data.json into an empty library.
    func importData(_ data: JSON) async throws { _ = try await call("data.import", ["data": data], as: JSON.self) }
    func createBackup() async throws -> LearningBackup { try await call("backup.create") }
    func backups() async throws -> [LearningBackup] { try await call("backup.list") }
    func restoreBackup(_ name: String) async throws -> LearningRestored { try await call("backup.restore", ["name": .string(name)]) }
    /// Deletes every piece of learning data. The engine refuses without this exact word.
    func deleteAllLearningData() async throws {
        _ = try await call("data.delete", ["confirm": "delete-learning-data"], as: JSON.self)
    }
}

enum LearningDataText {
    /// What deleting removes, with counts, for the confirmation.
    static func scope(_ s: LearningDataSummary) -> String {
        String(localized: "将删除：\(s.notebooks) 个笔记本（\(s.notes) 条笔记）、\(s.memories) 条学习记忆、\(s.documents) 份知识库资料、\(s.questions) 道题目（含错题本）、\(s.research) 个研究任务，以及学习设置、导出和备份。不会删除：DSH 的会话、Bot 和 Bot 记忆、插件、设置，以及「我的 Skills」里的 Skill。删除后无法恢复。")
    }
}

struct LearningDataPage: View {
    @Environment(AppModel.self) private var app
    @State private var summary: LearningDataSummary?
    @State private var backups: [LearningBackup] = []
    @State private var working = false
    @State private var exported: URL?
    @State private var importing = false
    @State private var restoring: LearningBackup?
    @State private var confirmingDelete = false
    @State private var confirmingDeleteAgain = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            Section {
                Button("导出全部学习数据") { Task { await export() } }.disabled(working)
                if let exported {
                    ShareLink(item: exported) { Label("分享或存到「文件」", systemImage: "square.and.arrow.up") }
                }
                Button("从导出导入（data.json）") { importing = true }.disabled(working)
            } header: {
                Text("导出与导入")
            } footer: {
                Text("导出是一个文件夹：笔记是 Markdown，研究报告是 Markdown，其余数据在 data.json 里。导入只能导入到空的学习库。")
            }
            Section {
                Button("立即备份") { Task { await backup() } }.disabled(working)
                ForEach(backups) { item in
                    Button { restoring = item } label: {
                        LabeledContent(item.name) { Text(ByteCountFormatter.string(fromByteCount: Int64(item.bytes), countStyle: .file)) }
                    }
                    .disabled(working)
                }
            } header: {
                Text("备份与恢复")
            } footer: {
                Text("备份是学习库的完整副本，保存在这台设备上。恢复前会检查备份文件，并先把当前学习库另存为一份备份。")
            }
            Section {
                Button("删除全部学习数据", role: .destructive) { confirmingDelete = true }.disabled(working || summary == nil)
            } footer: {
                if let summary { Text(LearningDataText.scope(summary)) }
            }
        }
        .groupedList()
        .navigationTitle("学习数据")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView() } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            if case .success(let url) = result { Task { await importFile(url) } }
        }
        .confirmationDialog(
            "用这份备份替换当前学习库？",
            isPresented: Binding(get: { restoring != nil }, set: { if !$0 { restoring = nil } }),
            titleVisibility: .visible,
            presenting: restoring
        ) { item in
            Button("恢复 \(item.name)", role: .destructive) { Task { await restore(item) } }
        } message: { _ in
            Text("当前学习库会先另存为一份备份。")
        }
        .confirmationDialog("删除全部学习数据？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("继续", role: .destructive) { confirmingDeleteAgain = true }
        } message: {
            if let summary { Text(LearningDataText.scope(summary)) }
        }
        .alert("真的要删除吗？", isPresented: $confirmingDeleteAgain) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await deleteAll() } }
        } message: {
            Text("学习库、导出和备份都会删除，无法恢复。")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        summary = try? await client.dataSummary()
        backups = (try? await client.backups()) ?? []
    }

    private func run(_ work: () async throws -> Void) async {
        working = true
        defer { working = false }
        do { try await work() } catch { app.showToast(error.localizedDescription, tone: .warning) }
    }

    private func export() async {
        await run {
            let result = try await client.exportData()
            exported = EnginePaths.real(result.path)
            Haptics.select()
        }
    }

    private func importFile(_ url: URL) async {
        await run {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try JSON.parse(try Data(contentsOf: url))
            try await client.importData(data)
            await load()
            app.showToast(String(localized: "已导入学习数据"))
        }
    }

    private func backup() async {
        await run {
            _ = try await client.createBackup()
            await load()
        }
    }

    private func restore(_ item: LearningBackup) async {
        await run {
            _ = try await client.restoreBackup(item.name)
            await load()
            app.showToast(String(localized: "已恢复备份"))
        }
    }

    private func deleteAll() async {
        Haptics.firm()
        await run {
            try await client.deleteAllLearningData()
            exported = nil
            await load()
            app.showToast(String(localized: "已删除全部学习数据"))
        }
    }
}
