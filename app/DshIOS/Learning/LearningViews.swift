import SwiftUI

// The learning screens (milestone 1): notebooks with their notes, and the learner's long-term
// memory. Everything is read and written through LearningClient (engine/plugins/learning);
// nothing here touches Bot memory or sessions.

/// Settings → 学习.
struct LearningHomePage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openSession) private var openSession
    @State private var notebooks: [LearningNotebook] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var creating = false
    @State private var newTitle = ""
    @State private var renaming: LearningNotebook?
    @State private var renameTitle = ""
    @State private var deleting: LearningNotebook?
    @State private var learningSessions: [LearningSessionMode] = []
    @State private var settings: LearningSettings?
    @State private var starting: LearningMode?

    private var client: LearningClient { LearningClient(engine: app.client) }

    /// Learning sessions the app still has (an archived or deleted one is not offered).
    private var openableSessions: [LearningSessionMode] {
        learningSessions.filter { app.sessions[$0.sessionId] != nil }
    }

    var body: some View {
        page(
            List {
                modesSection
                sessionsSection
                memorySection
                notebooksSection
            }
            .groupedList()
        )
    }

    @ViewBuilder private var modesSection: some View {
        // Milestone 2: each mode starts an ordinary DSH session that the engine tells the mode's
        // instructions (engine/skills/learning-<mode>/SKILL.md) at each turn.
        Section {
            ForEach(LearningMode.allCases) { mode in
                Button { Task { await start(mode) } } label: {
                    HStack(alignment: .firstTextBaseline) {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(mode.title).foregroundStyle(.primary)
                                Text(mode.summary).font(.footnote).foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: mode.systemImage)
                        }
                        Spacer(minLength: 8)
                        if starting == mode { ProgressView() }
                    }
                }
                .disabled(starting != nil)
            }
        } header: {
            Text("开始学习")
        } footer: {
            Text("每种模式都会新建一个普通会话。模式说明来自随 App 提供的 skill，在任何会话里也可以用 /learning-qa、/learning-socratic、/learning-quiz 调用。")
        }
    }

    @ViewBuilder private var sessionsSection: some View {
        if !openableSessions.isEmpty {
            Section {
                ForEach(openableSessions, id: \.sessionId) { entry in
                    Button { open(entry.sessionId) } label: {
                        LabeledContent {
                            Text(entry.mode.title)
                        } label: {
                            Label(sessionTitle(entry.sessionId), systemImage: entry.mode.systemImage)
                                .foregroundStyle(.primary)
                        }
                    }
                    .swipeActions {
                        Button("结束学习模式") { Task { await endMode(entry.sessionId) } }
                    }
                    .contextMenu {
                        Button("结束学习模式", systemImage: "xmark.circle") { Task { await endMode(entry.sessionId) } }
                    }
                }
            } header: {
                Text("学习会话")
            } footer: {
                Text("结束学习模式后，会话和聊天记录都还在，只是之后的回合不再按学习模式回答。")
            }
        }
    }

    private var memorySection: some View {
        Section {
            NavigationLink { LearningMemoryPage() } label: {
                Label("学习记忆", systemImage: "brain.head.profile")
            }
            Toggle(isOn: Binding(
                get: { settings?.injectMemories ?? true },
                set: { on in Task { await setInject(on) } }
            )) {
                Label("在学习会话中使用学习记忆", systemImage: "text.badge.plus")
            }
            .disabled(settings == nil)
            NavigationLink { LearningSkillsPage() } label: {
                Label("我的 Skills", systemImage: "wand.and.stars")
            }
            NavigationLink { KnowledgeBasePage() } label: {
                Label("知识库", systemImage: "books.vertical")
            }
            NavigationLink { QuizBankPage() } label: {
                Label("题库与错题本", systemImage: "list.bullet.clipboard")
            }
        } footer: {
            Text("学习记忆只供学习功能使用，和 Bot 的记忆分开保存。开启后，学习会话每一轮会按相关度附上最多 3 条学习记忆（合计不超过 800 字），普通会话不受影响。")
        }
    }

    private var notebooksSection: some View {
        Section {
            if !loaded {
                ProgressView().frame(maxWidth: .infinity)
            } else if let loadError {
                Text(loadError).font(.footnote).foregroundStyle(.red)
            } else if notebooks.isEmpty {
                Text("还没有笔记本。点右上角的 + 新建一个。").font(.footnote).foregroundStyle(.secondary)
            } else {
                ForEach(notebooks) { book in
                    NavigationLink { NotebookPage(notebook: book) } label: {
                        LabeledContent {
                            Text("\(book.noteCount) 条笔记")
                        } label: {
                            Label(book.title, systemImage: "book.closed")
                        }
                    }
                    .swipeActions {
                        Button("删除", role: .destructive) { deleting = book }
                        Button("重命名") { renameTitle = book.title; renaming = book }
                    }
                    .contextMenu {
                        Button("重命名", systemImage: "pencil") { renameTitle = book.title; renaming = book }
                        Button("删除", systemImage: "trash", role: .destructive) { deleting = book }
                    }
                }
            }
        } header: {
            Text("笔记本")
        }
    }

    /// The page around the sections: its title, toolbar and the notebook dialogs.
    private func page<Content: View>(_ list: Content) -> some View {
        list
        .navigationTitle("学习")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newTitle = ""; creating = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("新建笔记本")
            }
        }
        .alert("新建笔记本", isPresented: $creating) {
            TextField("名称", text: $newTitle)
            Button("取消", role: .cancel) {}
            Button("创建") { Task { await create() } }
        }
        .alert("重命名笔记本", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("名称", text: $renameTitle)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") { if let book = renaming { Task { await rename(book) } } }
        }
        .confirmationDialog(
            "删除这个笔记本？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { book in
            Button("删除笔记本和其中的 \(book.noteCount) 条笔记", role: .destructive) { Task { await delete(book) } }
        } message: { _ in
            Text("删除后无法恢复。")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            notebooks = try await client.notebooks()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
        // The mode list and the setting are extras: a failure here leaves the notebooks usable.
        if let modes = try? await client.sessionModes() { learningSessions = modes }
        if let current = try? await client.settings() { settings = current }
    }

    private func sessionTitle(_ id: String) -> String {
        let title = app.sessions[id]?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? String(localized: "新会话") : title
    }

    private func open(_ sessionId: String) {
        if let openSession { openSession(sessionId) }
        else { app.showToast(String(localized: "学习会话已建好，可在会话列表中打开")) }
    }

    /// A new session (or the blank one already there) in `mode`, then open it.
    private func start(_ mode: LearningMode) async {
        guard let workspace = app.workspaces.first else {
            app.showToast(String(localized: "还没有工作区，暂时无法新建会话"), tone: .warning)
            return
        }
        starting = mode
        defer { starting = nil }
        do {
            let session = try await app.createSession(in: workspace)
            guard !session.isEmpty else { throw LearningError(kind: "transport", message: String(localized: "新建会话失败"), status: 0) }
            try await client.setMode(mode, for: session)
            Haptics.select()
            open(session)
            if let modes = try? await client.sessionModes() { learningSessions = modes }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func endMode(_ sessionId: String) async {
        do {
            try await client.setMode(nil, for: sessionId)
            learningSessions.removeAll { $0.sessionId == sessionId }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func setInject(_ on: Bool) async {
        let before = settings
        settings = LearningSettings(injectMemories: on)
        do {
            settings = try await client.setInjectMemories(on)
        } catch {
            settings = before
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func create() async {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        do {
            _ = try await client.createNotebook(title: title)
            await load()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func rename(_ book: LearningNotebook) async {
        renaming = nil
        let title = renameTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != book.title else { return }
        do {
            _ = try await client.renameNotebook(book.id, title: title)
            await load()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func delete(_ book: LearningNotebook) async {
        Haptics.firm()
        do {
            try await client.deleteNotebook(book.id)
            notebooks.removeAll { $0.id == book.id }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// What the note editor opens with: an existing note, or a new one in `notebookId`.
struct LearningNoteDraft: Identifiable {
    let id = UUID()
    var noteId: Int?
    let notebookId: Int
    var title: String
    var body: String
}

/// One notebook: its notes, newest first, and a search over them.
struct NotebookPage: View {
    @Environment(AppModel.self) private var app
    let notebook: LearningNotebook
    @State private var notes: [LearningNote] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var query = ""
    @State private var hits: [LearningSearchHit] = []
    @State private var searching = false
    @State private var editing: LearningNoteDraft?

    private var client: LearningClient { LearningClient(engine: app.client) }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        List {
            if !trimmedQuery.isEmpty {
                Section {
                    if searching && hits.isEmpty {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if hits.isEmpty {
                        Text("没有找到包含「\(trimmedQuery)」的笔记。").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(hits) { hit in
                            Button { Task { await open(hit.id) } } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(hit.title.isEmpty ? String(localized: "无标题") : hit.title).foregroundStyle(.primary)
                                    Text(hit.excerpt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                        }
                    }
                } header: {
                    Text("搜索结果")
                }
            } else {
                Section {
                    if !loaded {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if let loadError {
                        Text(loadError).font(.footnote).foregroundStyle(.red)
                    } else if notes.isEmpty {
                        Text("这个笔记本还是空的。点右上角的 + 写第一条笔记。").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(notes) { note in
                            Button {
                                editing = LearningNoteDraft(noteId: note.id, notebookId: notebook.id, title: note.title, body: note.body)
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(note.title.isEmpty ? String(localized: "无标题") : note.title).foregroundStyle(.primary)
                                    if !note.body.isEmpty {
                                        Text(note.body).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                            }
                            .swipeActions {
                                Button("删除", role: .destructive) { Task { await delete(note) } }
                            }
                        }
                    }
                }
            }
        }
        .groupedList()
        .navigationTitle(notebook.title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: Text("搜索这个笔记本"))
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    editing = LearningNoteDraft(noteId: nil, notebookId: notebook.id, title: "", body: "")
                } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("新建笔记")
            }
        }
        .sheet(item: $editing) { draft in
            NavigationStack {
                LearningNoteEditor(draft: draft) { await load() }
            }
        }
        .task { await load() }
        .task(id: trimmedQuery) { await search(trimmedQuery) }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            notes = try await client.notes(in: notebook.id)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func search(_ text: String) async {
        guard !text.isEmpty else { hits = []; return }
        // A burst of typing searches once.
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        searching = true
        defer { searching = false }
        do {
            let found = try await client.search(text, in: notebook.id)
            guard !Task.isCancelled else { return }
            hits = found.results
        } catch {
            guard !Task.isCancelled else { return }
            hits = []
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func open(_ noteId: Int) async {
        do {
            let note = try await client.note(noteId)
            editing = LearningNoteDraft(noteId: note.id, notebookId: note.notebookId, title: note.title, body: note.body)
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func delete(_ note: LearningNote) async {
        Haptics.firm()
        do {
            try await client.deleteNote(note.id)
            notes.removeAll { $0.id == note.id }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// Writes or edits one note; saves only when the user taps Save.
struct LearningNoteEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let draft: LearningNoteDraft
    let saved: () async -> Void
    @State private var title: String
    @State private var text: String
    @State private var saving = false

    init(draft: LearningNoteDraft, saved: @escaping () async -> Void) {
        self.draft = draft
        self.saved = saved
        _title = State(initialValue: draft.title)
        _text = State(initialValue: draft.body)
    }

    private var unchanged: Bool { title == draft.title && text == draft.body }

    var body: some View {
        Form {
            Section {
                TextField("标题", text: $title)
            }
            Section {
                TextEditor(text: $text)
                    .frame(minHeight: 240)
            } header: {
                Text("内容")
            }
        }
        .navigationTitle(draft.noteId == nil ? "新建笔记" : "编辑笔记")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(!unchanged)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }
                    .disabled(saving || unchanged || (title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let client = LearningClient(engine: app.client)
        do {
            if let noteId = draft.noteId {
                _ = try await client.updateNote(noteId, title: title, body: text)
            } else {
                _ = try await client.createNote(in: draft.notebookId, title: title, body: text)
            }
            await saved()
            dismiss()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// The learner's long-term memory: what the learning features remember about the user.
struct LearningMemoryPage: View {
    @Environment(AppModel.self) private var app
    @State private var memories: [LearningMemory] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var adding = false
    @State private var newContent = ""
    @State private var editing: LearningMemory?
    @State private var editContent = ""
    @State private var confirmingClear = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            Section {
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.red)
                } else if memories.isEmpty {
                    Text("还没有学习记忆。点右上角的 + 添加，比如你的学习目标或偏好。").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(memories) { memory in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(memory.content)
                            Text(memory.source == "user" ? String(localized: "你添加的") : String(localized: "学习时记下的"))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .swipeActions {
                            Button("删除", role: .destructive) { Task { await delete(memory) } }
                            Button("编辑") { editContent = memory.content; editing = memory }
                        }
                        .contextMenu {
                            Button("编辑", systemImage: "pencil") { editContent = memory.content; editing = memory }
                            Button("删除", systemImage: "trash", role: .destructive) { Task { await delete(memory) } }
                        }
                    }
                }
            } footer: {
                Text("只保存在这台设备上。这里的内容和 Bot 的记忆互不影响。")
            }
            if !memories.isEmpty {
                Section {
                    Button("清空学习记忆", role: .destructive) { confirmingClear = true }
                }
            }
        }
        .groupedList()
        .navigationTitle("学习记忆")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { newContent = ""; adding = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("添加学习记忆")
            }
        }
        .alert("添加学习记忆", isPresented: $adding) {
            TextField("要记住的内容", text: $newContent, axis: .vertical)
            Button("取消", role: .cancel) {}
            Button("添加") { Task { await add() } }
        }
        .alert("编辑学习记忆", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            TextField("要记住的内容", text: $editContent, axis: .vertical)
            Button("取消", role: .cancel) { editing = nil }
            Button("保存") { if let memory = editing { Task { await update(memory) } } }
        }
        .confirmationDialog("清空学习记忆？", isPresented: $confirmingClear, titleVisibility: .visible) {
            Button("清空 \(memories.count) 条学习记忆", role: .destructive) { Task { await clear() } }
        } message: {
            Text("只清空学习记忆。笔记和 Bot 的记忆不受影响。清空后无法恢复。")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            memories = try await client.memories()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func add() async {
        let content = newContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty else { return }
        do {
            _ = try await client.addMemory(content)
            await load()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func update(_ memory: LearningMemory) async {
        editing = nil
        let content = editContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, content != memory.content else { return }
        do {
            let updated = try await client.updateMemory(memory.id, content: content)
            if let index = memories.firstIndex(where: { $0.id == memory.id }) { memories[index] = updated }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func delete(_ memory: LearningMemory) async {
        Haptics.firm()
        do {
            try await client.deleteMemory(memory.id)
            memories.removeAll { $0.id == memory.id }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func clear() async {
        Haptics.firm()
        do {
            let count = try await client.clearMemories()
            memories = []
            app.showToast(String(localized: "已清空 \(count) 条学习记忆"), tone: .success)
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}
