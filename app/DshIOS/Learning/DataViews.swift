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
    /// When the file was written, ms since 1970 (older engines: absent).
    var createdAt: Double?
    /// "manual", or "before-restore" for the copy taken just before a restore.
    var kind: String?
    var id: String { name }
    var date: Date? { createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var isBeforeRestore: Bool { kind == "before-restore" }
}

/// The phone's own clock and time zone as the engine puts it in file names
/// (`YYYY-MM-DD-HH-mm-ss`, portable.mjs `stamp`): the engine may not know the time zone.
enum LearningStamp {
    static func now() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd-HH-mm-ss"
        return formatter.string(from: .now)
    }
}

struct LearningRestored: Codable, Sendable {
    let restored: String
    let schemaVersion: Int
    let previous: String?
}

extension LearningClient {
    func dataSummary() async throws -> LearningDataSummary { try await call("data.summary") }
    func exportData() async throws -> LearningExport { try await call("data.export", ["local": .string(LearningStamp.now())]) }
    /// Import the contents of an export's data.json into an empty library.
    func importData(_ data: JSON) async throws { _ = try await call("data.import", ["data": data], as: JSON.self) }
    func createBackup() async throws -> LearningBackup { try await call("backup.create", ["local": .string(LearningStamp.now())]) }
    func backups() async throws -> [LearningBackup] { try await call("backup.list") }
    func restoreBackup(_ name: String) async throws -> LearningRestored {
        try await call("backup.restore", ["name": .string(name), "local": .string(LearningStamp.now())])
    }
    /// Deletes one backup, by its name in the list.
    func deleteBackup(_ name: String) async throws { _ = try await call("backup.delete", ["name": .string(name)], as: JSON.self) }
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
    @State private var deleting: LearningBackup?
    @State private var confirmingBackup = false
    @State private var confirmingDelete = false
    @State private var confirmingDeleteAgain = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            Section {
                // A second tap folds the share row away again; the next tap after that exports anew.
                Button("导出全部学习数据") {
                    if exported != nil { withAnimation { exported = nil } } else { Task { await export() } }
                }
                .disabled(working)
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
                Button("立即备份") { confirmingBackup = true }.disabled(working)
                // Tap: restore. Long press: restore or delete.
                ForEach(backups) { item in
                    Button { restoring = item } label: { backupRow(item) }
                        .disabled(working)
                        .contextMenu {
                            Button("恢复", systemImage: "arrow.counterclockwise") { restoring = item }
                            Button("删除", systemImage: "trash", role: .destructive) { deleting = item }
                        }
                }
            } header: {
                Text("备份与恢复")
            } footer: {
                Text("备份是学习库的完整副本，保存在这台设备上。点一下恢复，长按可删除。恢复前会检查备份文件，并先把当前学习库另存为一份备份。")
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
        .confirmationDialog("现在备份学习库？", isPresented: $confirmingBackup, titleVisibility: .visible) {
            Button("备份") { Task { await backup() } }
        } message: {
            Text("会在这台设备上保存一份学习库的完整副本。")
        }
        .alert(
            "删除这份备份？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { item in
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) { Task { await deleteBackup(item) } }
        } message: { item in
            Text("\(item.name) 删除后无法找回。")
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

    private func backupRow(_ item: LearningBackup) -> some View {
        LabeledContent {
            Text(ByteCountFormatter.string(fromByteCount: Int64(item.bytes), countStyle: .file))
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                if let date = item.date {
                    Text(date.formatted(date: .abbreviated, time: .standard)).foregroundStyle(.primary)
                } else {
                    Text(verbatim: item.name).foregroundStyle(.primary)
                }
                Group {
                    if item.isBeforeRestore { Text("恢复前自动备份 · \(item.name)") } else { Text(verbatim: item.name) }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
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

    private func deleteBackup(_ item: LearningBackup) async {
        await run {
            try await client.deleteBackup(item.name)
            await load()
            app.showToast(String(localized: "已删除备份"))
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
