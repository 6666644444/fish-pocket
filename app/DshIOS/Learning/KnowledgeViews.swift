import SwiftUI
import UniformTypeIdentifiers

// Settings → 学习 → 知识库 (milestone 3): import txt, Markdown and PDFs with a text layer,
// search them with citations, and choose how vectors are made. Everything goes through
// LearningClient (engine/plugins/learning kb.*). Only system styles; nobody has looked at it
// on a device yet.

struct KnowledgeBasePage: View {
    @Environment(AppModel.self) private var app
    @State private var documents: [KnowledgeDocument] = []
    @State private var status: KnowledgeStatus?
    @State private var loaded = false
    @State private var loadError: String?
    @State private var picking = false
    @State private var importing = false
    @State private var deleting: KnowledgeDocument?

    private var client: LearningClient { LearningClient(engine: app.client) }
    private static let types: [UTType] = [.plainText, .pdf] + [UTType(filenameExtension: "md"), UTType(filenameExtension: "markdown")].compactMap { $0 }

    var body: some View {
        List {
            Section {
                NavigationLink { KnowledgeSearchPage() } label: { Label("搜索知识库", systemImage: "magnifyingglass") }
                NavigationLink { KnowledgeSettingsPage() } label: { Label("向量与检索设置", systemImage: "slider.horizontal.3") }
            } footer: {
                if let status { Text(summary(status)) }
            }
            Section {
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.red)
                } else if documents.isEmpty {
                    Text("还没有资料。点右上角的 + 导入 txt、Markdown 或 PDF。").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(documents) { document in
                        VStack(alignment: .leading, spacing: 3) {
                            Label(document.title, systemImage: icon(document.kind))
                            Text("\(document.chunkCount) 段 · \(document.chars) 字").font(.caption).foregroundStyle(.secondary)
                            if document.embeddingStatus == "unavailable" {
                                Text("这台设备没有这种语言的句向量，只能按关键词检索").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions { Button("删除", role: .destructive) { deleting = document } }
                    }
                }
            } header: {
                Text("资料")
            } footer: {
                Text("扫描件 PDF（没有文字层）暂不支持。资料只保存在这台设备的学习库里。")
            }
        }
        .groupedList()
        .navigationTitle("知识库")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if importing { ProgressView() } else {
                    Button { picking = true } label: { Image(systemName: "plus") }.accessibilityLabel("导入资料")
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: Self.types, allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { Task { await importFiles(urls) } }
        }
        .confirmationDialog(
            "删除这份资料？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { document in
            Button("删除「\(document.title)」和它的 \(document.chunkCount) 段", role: .destructive) { Task { await delete(document) } }
        } message: { _ in
            Text("只删除知识库里的这份资料，原文件不受影响。")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func icon(_ kind: String) -> String {
        switch kind { case "pdf": "doc.richtext"; case "md": "number"; default: "doc.plaintext" }
    }

    private func summary(_ status: KnowledgeStatus) -> String {
        let vectors = status.vectors.models.map { "\($0.model)：\($0.chunks)/\(status.vectors.chunks)" }.joined(separator: "，")
        return vectors.isEmpty
            ? String(localized: "共 \(status.vectors.chunks) 段，目前只按关键词检索。")
            : String(localized: "共 \(status.vectors.chunks) 段。已建向量：\(vectors)")
    }

    private func load() async {
        do {
            documents = try await client.documents()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
        status = try? await client.knowledgeStatus()
    }

    private func importFiles(_ urls: [URL]) async {
        importing = true
        defer { importing = false }
        var added = 0
        for url in urls {
            do {
                let file = try KnowledgeFiles.read(url)
                _ = try await client.importDocument(title: file.title, kind: file.kind, text: file.text, sourceName: url.lastPathComponent)
                added += 1
            } catch {
                app.showToast("\(url.lastPathComponent)：\(error.localizedDescription)", tone: .warning)
            }
        }
        if added > 0 {
            Haptics.select()
            await load()
            // Apple's vectors are made by the engine on its own; a provider set up here runs now.
            if let provider = EmbeddingProvider.current {
                do { try await provider.indexPending(client) } catch { app.showToast(error.localizedDescription, tone: .warning) }
                status = try? await client.knowledgeStatus()
            }
        }
    }

    private func delete(_ document: KnowledgeDocument) async {
        Haptics.firm()
        do {
            try await client.deleteDocument(document.id)
            documents.removeAll { $0.id == document.id }
            status = try? await client.knowledgeStatus()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

struct KnowledgeSearchPage: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var result: KnowledgeSearchResult?
    @State private var searching = false
    @State private var opened: KnowledgeHit?

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            if let result {
                Section {
                    if result.results.isEmpty {
                        Text("没有找到相关内容。").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(result.results) { hit in
                        Button { opened = hit } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(hit.label).font(.caption).foregroundStyle(.secondary)
                                Text(hit.excerpt).font(.callout).foregroundStyle(.primary).lineLimit(4)
                            }
                        }
                    }
                } footer: {
                    Text(modeText(result.mode))
                }
            }
        }
        .groupedList()
        .navigationTitle("搜索知识库")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: Text("关键词或一句话"))
        .onSubmit(of: .search) { Task { await search() } }
        .overlay { if searching { ProgressView() } }
        .sheet(item: $opened) { hit in
            NavigationStack { KnowledgeChunkPage(hit: hit) }
        }
    }

    private func modeText(_ mode: String) -> String {
        switch mode {
        case "hybrid": String(localized: "按关键词和语义一起排序。")
        case "fts", "like": String(localized: "按关键词排序。")
        default: ""
        }
    }

    private func search() async {
        guard !trimmed.isEmpty else { return }
        searching = true
        defer { searching = false }
        let client = LearningClient(engine: app.client)
        var vectors: [(model: String, vector: [Float])] = []
        if let provider = EmbeddingProvider.current, let vector = try? await provider.embed([trimmed]).first {
            vectors.append((provider.engineModel, vector))
        }
        do {
            result = try await client.searchKnowledge(trimmed, queryVectors: vectors)
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// One hit in full: the citation and the chunk's text.
struct KnowledgeChunkPage: View {
    @Environment(\.dismiss) private var dismiss
    let hit: KnowledgeHit

    var body: some View {
        List {
            Section {
                LabeledContent("出处") { Text(hit.label) }
            }
            Section {
                Text(hit.excerpt).textSelection(.enabled)
            } header: {
                Text("原文片段")
            }
        }
        .groupedList()
        .navigationTitle(hit.documentTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
    }
}

struct KnowledgeSettingsPage: View {
    @Environment(AppModel.self) private var app
    @State private var settings: LearningSettings?
    @State private var available = false
    @State private var baseURL = EmbeddingProvider.current?.baseURL ?? ""
    @State private var model = EmbeddingProvider.current?.model ?? ""
    @State private var apiKey = ""
    @State private var hasKey = LearningKeychain.read(EmbeddingProvider.keyAccount)?.isEmpty == false
    @State private var working = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        Form {
            Section {
                Toggle(isOn: Binding(get: { settings?.appleEmbedding ?? true }, set: { on in Task { await setApple(on) } })) {
                    Text("使用 Apple 设备端句向量")
                }
                .disabled(settings == nil || !available)
            } footer: {
                if available {
                    Text("默认方案：在设备上用 Apple 的句向量按语义检索，再和关键词结果合并排序，不联网、不需要 Key。没有对应语言句向量的资料只按关键词检索。")
                } else {
                    Text("这个环境没有 Apple 的句向量，只能按关键词检索。")
                }
            }
            Section {
                TextField("https://api.example.com/v1", text: $baseURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                TextField("模型，例如 text-embedding-3-small", text: $model)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField(hasKey ? String(localized: "已保存，留空表示不修改") : String(localized: "API Key"), text: $apiKey)
                Button("保存") { save() }.disabled(working)
                if EmbeddingProvider.current != nil {
                    Button("用这个服务为全部资料建立向量") { Task { await indexAll() } }.disabled(working)
                    Button("停用这个服务", role: .destructive) { remove() }.disabled(working)
                }
            } header: {
                Text("OpenAI 兼容向量服务（可选）")
            } footer: {
                Text("填写后，导入和搜索时会把资料文字发给这个服务来生成向量。Key 只保存在这台设备的钥匙串里，不会交给引擎。")
            }
        }
        .navigationTitle("向量与检索设置")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            settings = try? await client.settings()
            available = (try? await client.knowledgeStatus())?.appleEmbedding.available ?? false
        }
    }

    private func setApple(_ on: Bool) async {
        do { settings = try await client.setAppleEmbedding(on) } catch { app.showToast(error.localizedDescription, tone: .warning) }
    }

    private func save() {
        let base = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let provider = EmbeddingProvider(baseURL: base, model: name)
        guard !name.isEmpty, provider.endpoint != nil else {
            app.showToast(String(localized: "地址必须以 https:// 开头，并且要填写模型"), tone: .warning)
            return
        }
        EmbeddingProvider.save(provider)
        if !apiKey.isEmpty { LearningKeychain.write(EmbeddingProvider.keyAccount, apiKey); apiKey = ""; hasKey = true }
        Haptics.select()
    }

    private func remove() {
        EmbeddingProvider.save(nil)
        LearningKeychain.write(EmbeddingProvider.keyAccount, nil)
        baseURL = ""; model = ""; apiKey = ""; hasKey = false
    }

    private func indexAll() async {
        guard let provider = EmbeddingProvider.current else { return }
        working = true
        defer { working = false }
        do {
            let stored = try await provider.indexPending(client)
            app.showToast(String(localized: "已为 \(stored) 段建立向量"))
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}
