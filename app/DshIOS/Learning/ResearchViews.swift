import SwiftUI

// Settings → 学习 → 深度研究 (milestone 5). Research is started by the model in a conversation
// (the engine's `deep_research` tool and the bundled deep-research skill); here the learner
// follows jobs, reads reports, resumes a paused job, cancels or deletes one, and chooses
// whether research may search the web. Engine: engine/plugins/learning research*.mjs.

struct ResearchJob: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    let sessionId: String?
    let topic: String
    /// "quick", "standard" or "deep".
    let depth: String
    let sources: [String]
    /// "planned", "running", "paused", "done", "failed" or "cancelled".
    let status: String
    let phase: String
    let progress: String
    let cancelRequested: Bool
    let callsUsed: Int
    let blocks: Int
    let blocksDone: Int
    let citations: Int
    let error: String?
    /// Only in `research.get`.
    let report: String?
    let createdAt: Double
    let updatedAt: Double

    var isActive: Bool { status == "running" || status == "planned" }
    var canResume: Bool { status == "paused" || status == "planned" }
}

struct ResearchClaim: Codable, Hashable, Sendable {
    let key: String
    let claim: String
    /// "corroborated", "single-source", "conflicting" or "refuted".
    let status: String
    let note: String
    let citations: [String]
}

struct ResearchStarted: Codable, Sendable {
    let started: Bool
    let reason: String?
}

extension LearningClient {
    func researchJobs() async throws -> [ResearchJob] { try await call("research.list", ["limit": 100]) }
    func researchJob(_ id: Int) async throws -> ResearchJob { try await call("research.get", ["id": .number(Double(id))]) }
    func researchClaims(_ id: Int) async throws -> [ResearchClaim] { try await call("research.claims", ["id": .number(Double(id))]) }
    func resumeResearch(_ id: Int) async throws -> ResearchStarted { try await call("research.resume", ["id": .number(Double(id))]) }
    func cancelResearch(_ id: Int) async throws -> ResearchJob { try await call("research.cancel", ["id": .number(Double(id))]) }
    func deleteResearch(_ id: Int) async throws {
        _ = try await call("research.delete", ["id": .number(Double(id))], as: LearningDeleted.self)
    }
    func setResearchWeb(_ on: Bool) async throws -> LearningSettings { try await call("settings.update", ["researchWeb": .bool(on)]) }
}

enum ResearchText {
    static func status(_ job: ResearchJob) -> String {
        switch job.status {
        case "planned": String(localized: "等待开始")
        case "running": job.cancelRequested ? String(localized: "正在停止") : String(localized: "进行中")
        case "paused": String(localized: "已暂停")
        case "done": String(localized: "已完成")
        case "failed": String(localized: "失败")
        case "cancelled": String(localized: "已取消")
        default: job.status
        }
    }

    static func depth(_ depth: String) -> String {
        switch depth {
        case "quick": String(localized: "快速")
        case "deep": String(localized: "深入")
        default: String(localized: "标准")
        }
    }

    static func claim(_ status: String) -> String {
        switch status {
        case "corroborated": String(localized: "多个来源一致")
        case "single-source": String(localized: "只有一个来源")
        case "conflicting": String(localized: "来源之间有矛盾")
        case "refuted": String(localized: "被证据推翻")
        default: status
        }
    }
}

struct ResearchListPage: View {
    @Environment(AppModel.self) private var app
    @State private var jobs: [ResearchJob] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var settings: LearningSettings?

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { settings?.researchWeb ?? true }, set: { on in Task { await setWeb(on) } })) {
                    Text("研究时联网搜索")
                }
                .disabled(settings == nil)
            } footer: {
                Text("在任意会话里说「帮我深入研究……」即可开始。研究会拆解问题、多轮检索、交叉核对关键结论、补查遗漏，最后写出带来源的报告，通常要几分钟。关掉联网后只查你的知识库。")
            }
            Section {
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.red)
                } else if jobs.isEmpty {
                    Text("还没有研究任务。").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(jobs) { job in
                        NavigationLink { ResearchJobPage(jobId: job.id) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(job.topic).lineLimit(2)
                                Text("\(ResearchText.status(job)) · \(ResearchText.depth(job.depth)) · \(job.blocksDone)/\(job.blocks) 部分 · \(job.citations) 个来源")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text("研究任务")
            }
        }
        .groupedList()
        .navigationTitle("深度研究")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            jobs = try await client.researchJobs()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
        if let current = try? await client.settings() { settings = current }
    }

    private func setWeb(_ on: Bool) async {
        do { settings = try await client.setResearchWeb(on) } catch { app.showToast(error.localizedDescription, tone: .warning) }
    }
}

struct ResearchJobPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let jobId: Int
    @State private var job: ResearchJob?
    @State private var claims: [ResearchClaim] = []
    @State private var confirmingDelete = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            if let job {
                Section {
                    LabeledContent("状态") { Text(ResearchText.status(job)) }
                    if job.isActive && !job.progress.isEmpty { LabeledContent("进度") { Text(job.progress).lineLimit(2) } }
                    LabeledContent("深度") { Text(ResearchText.depth(job.depth)) }
                    LabeledContent("已研究") { Text("\(job.blocksDone)/\(job.blocks) 部分，\(job.citations) 个来源") }
                    if let error = job.error { Text(error).font(.footnote).foregroundStyle(.red) }
                } header: {
                    Text(job.topic)
                }
                Section {
                    if job.canResume { Button("继续研究") { Task { await resume() } } }
                    if job.isActive && !job.cancelRequested { Button("停止研究", role: .destructive) { Task { await cancel() } } }
                    if !job.isActive { Button("删除", role: .destructive) { confirmingDelete = true } }
                } footer: {
                    if job.canResume { Text("会从中断的那一步接着做，已完成的部分不会重做。") }
                }
                if !claims.isEmpty {
                    Section {
                        ForEach(claims, id: \.key) { claim in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ResearchText.claim(claim.status)).font(.caption).foregroundStyle(claim.status == "corroborated" ? Color.secondary : Color.orange)
                                Text(claim.claim).font(.callout)
                            }
                        }
                    } header: {
                        Text("关键结论核查")
                    }
                }
                if let report = job.report, job.status == "done" {
                    Section {
                        Text(Self.markdown(report)).textSelection(.enabled)
                        ShareLink(item: report) { Label("分享报告", systemImage: "square.and.arrow.up") }
                    } header: {
                        Text("报告")
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .groupedList()
        .navigationTitle("研究 #\(jobId)")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("删除这个研究任务？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("删除任务、来源和报告", role: .destructive) { Task { await delete() } }
        }
        .task {
            // Follow a running job until it settles.
            while !Task.isCancelled {
                await load()
                guard job?.isActive == true else { break }
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .refreshable { await load() }
    }

    /// The report's Markdown: inline styles and links rendered, line breaks kept.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }

    private func load() async {
        do {
            job = try await client.researchJob(jobId)
            claims = (try? await client.researchClaims(jobId)) ?? []
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func resume() async {
        do {
            let started = try await client.resumeResearch(jobId)
            if !started.started, let reason = started.reason { app.showToast(reason, tone: .warning) }
            await load()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func cancel() async {
        do { job = try await client.cancelResearch(jobId) } catch { app.showToast(error.localizedDescription, tone: .warning) }
    }

    private func delete() async {
        do {
            try await client.deleteResearch(jobId)
            dismiss()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}
