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
    @State private var history: [LearningHistoryEntry] = []
    /// Bots and groups in a learning mode, and those whose mode was ended (batch 2).
    @State private var owners: [LearningOwnerStatus] = []
    @State private var ownerRecord: [LearningOwnerStatus] = []
    @State private var settings: LearningSettings?
    /// Today's review of the mistake book (D53).
    @State private var review: QuizReview?
    @State private var reviewing = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    /// Learning sessions the app still has (an archived or deleted one is not offered).
    private var openableSessions: [LearningSessionMode] {
        learningSessions.filter { app.sessions[$0.sessionId] != nil }
    }

    /// The learning record, for sessions the app still has.
    private var openableHistory: [LearningHistoryEntry] {
        history.filter { app.sessions[$0.sessionId] != nil }
    }

    var body: some View {
        page(
            List {
                // Learning happens with a Bot or a group (D49): no new learning conversation from here.
                reviewSection
                companionSection
                withBotSection
                sessionsSection
                historySection
                memorySection
                notebooksSection
                diagnosticsSection
            }
            .groupedList()
        )
    }

    /// Firefly 伙伴 (D55).
    private var companionSection: some View {
        Section {
            NavigationLink { CompanionPage() } label: {
                Label("AI 伙伴", systemImage: "heart.text.square")
            }
        } footer: {
            Text("选一个 Bot 做长期伙伴：记住你们一起经历的事，慢慢了解你，也会在合适的时候主动找你。")
        }
    }

    /// 今日复习 and 学习统计 (D53).
    private var reviewSection: some View {
        Section {
            Button { reviewing = true } label: {
                LabeledContent {
                    if let review {
                        Text(review.due > 0 ? String(localized: "\(review.due) 题") : String(localized: "没有"))
                            .foregroundStyle(review.due > 0 ? Color.accentColor : .secondary)
                    }
                } label: {
                    Label("今日复习", systemImage: "calendar.badge.clock").foregroundStyle(.primary)
                }
            }
            NavigationLink { LearningStatsPage() } label: {
                Label("学习统计", systemImage: "chart.bar.xaxis")
            }
        } footer: {
            Text("答错的题第二天复习，之后隔 3 天、7 天各复习一次，到时间都答对就移出错题本。主屏幕上可以添加「错题复习」小组件。")
        }
        .task { review = await LearningReviewSync.refresh(client) }
        .sheet(isPresented: $reviewing, onDismiss: { Task { review = await LearningReviewSync.refresh(client) } }) {
            NavigationStack { QuizReviewPage() }
        }
    }

    /// 和 Bot 一起学: put a Bot or a group in a mode and open its chat. The mode follows the Bot
    /// or the group (engine dsbot.mjs); in a group its admin teaches, so a group needs one.
    @ViewBuilder private var withBotSection: some View {
        let team = app.botTeam
        let bots = team.bots.filter { !$0.hidden }
        let rooms = team.rooms.filter { !$0.hidden }
        if !bots.isEmpty || !rooms.isEmpty {
            Section {
                ForEach(bots) { bot in
                    Menu {
                        modeChoices { mode in Task { await learn(.bot(bot.id), in: mode) } }
                    } label: {
                        Label(bot.name, systemImage: "person.crop.circle").foregroundStyle(.primary)
                    }
                }
                ForEach(rooms) { room in
                    Menu {
                        modeChoices { mode in Task { await learn(.room(room.id), in: mode) } }
                    } label: {
                        LabeledContent {
                            if room.admin == nil { Text("没有群主") }
                        } label: {
                            Label(team.name(of: room), systemImage: "person.3").foregroundStyle(.primary)
                        }
                    }
                    .disabled(room.admin == nil)
                }
            } header: {
                Text("和 Bot 一起学")
            } footer: {
                Text("选一个 Bot 或群聊和一种模式，直接进入它的聊天。学习模式跟着 Bot 或群走；群聊里由群主当老师，没有群主的群要先在群详情里设一位。在任何聊天的菜单里也能随时切换。")
            }
        }
    }

    @ViewBuilder private func modeChoices(_ pick: @escaping (LearningMode) -> Void) -> some View {
        ForEach(LearningMode.allCases) { mode in
            Button(mode.title, systemImage: mode.systemImage) { pick(mode) }
        }
    }

    /// Which App Group the share extension and the widgets reach the app through (Shared/AppGroup.swift):
    /// after signing with a free Apple ID, this shows whether the signature kept one.
    @ViewBuilder private var diagnosticsSection: some View {
        Section {
            Text(AppGroup.diagnostics)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        } header: {
            Text("诊断")
        } footer: {
            Text("分享扩展和小组件靠 App Group 和 App 交换数据。显示「无」时，说明这次签名没有可用的 App Group。")
        }
    }

    /// The Bots and groups in a learning mode. A conversation put in one before D49 is listed too,
    /// only so that it can still be opened and ended: no new one is started from the app.
    @ViewBuilder private var sessionsSection: some View {
        if !openableSessions.isEmpty || !owners.isEmpty {
            Section {
                ForEach(owners, id: \.self) { entry in
                    if let mode = entry.mode {
                        Button { openOwner(entry.owner) } label: {
                            LabeledContent {
                                Text(entry.paused == true ? String(localized: "已暂停") : mode.title)
                            } label: {
                                Label(ownerTitle(entry), systemImage: entry.kind == "room" ? "person.3" : "person.crop.circle")
                                    .foregroundStyle(.primary)
                            }
                        }
                        .swipeActions {
                            Button("结束学习模式") { Task { await endOwner(entry) } }
                        }
                        .contextMenu {
                            Button("结束学习模式", systemImage: "xmark.circle") { Task { await endOwner(entry) } }
                        }
                    }
                }
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
                Text("正在学习")
            } footer: {
                Text("正在按学习模式回答的 Bot 和群聊。结束学习模式后会放进下面的「学习记录」，聊天记录都还在。")
            }
        }
    }

    /// Sessions whose learning mode was ended: still openable, and back into a mode with a long press.
    @ViewBuilder private var historySection: some View {
        if !openableHistory.isEmpty || !ownerRecord.isEmpty {
            Section {
                ForEach(ownerRecord, id: \.self) { entry in
                    Button { openOwner(entry.owner) } label: {
                        LabeledContent {
                            if let ended = entry.endedDate { Text(ended.formatted(date: .abbreviated, time: .shortened)) }
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(ownerTitle(entry)).foregroundStyle(.primary)
                                    if let mode = entry.mode { Text(mode.title).font(.footnote).foregroundStyle(.secondary) }
                                }
                            } icon: {
                                Image(systemName: entry.kind == "room" ? "person.3" : "person.crop.circle")
                            }
                        }
                    }
                    .contextMenu {
                        Menu("重新开启学习模式", systemImage: "arrow.uturn.backward.circle") {
                            modeChoices { mode in Task { await learn(entry.owner, in: mode, open: false) } }
                        }
                        Button("从记录里移除", systemImage: "eye.slash") { Task { await hideOwner(entry) } }
                    }
                }
                ForEach(openableHistory, id: \.sessionId) { entry in
                    Button { open(entry.sessionId) } label: {
                        LabeledContent {
                            Text(entry.endedDate.formatted(date: .abbreviated, time: .shortened))
                        } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(sessionTitle(entry.sessionId)).foregroundStyle(.primary)
                                    Text(entry.mode.title).font(.footnote).foregroundStyle(.secondary)
                                }
                            } icon: {
                                Image(systemName: entry.mode.systemImage)
                            }
                        }
                    }
                    // A conversation is not put back in a mode (D49): learning goes on with a Bot.
                    .contextMenu {
                        Button("从记录里移除", systemImage: "eye.slash") { Task { await hide(entry.sessionId) } }
                    }
                }
            } header: {
                Text("学习记录")
            } footer: {
                Text("已结束学习模式的 Bot、群聊和会话。点一下打开；长按可从记录里移除（聊天本身不会删除），Bot 和群聊还能重新开启学习模式。")
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
            NavigationLink { ResearchListPage() } label: {
                Label("深度研究", systemImage: "doc.text.magnifyingglass")
            }
            NavigationLink { LearningDataPage() } label: {
                Label("学习数据", systemImage: "externaldrive")
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
        if let ended = try? await client.learningHistory() { history = ended }
        await loadOwners()
        if let current = try? await client.settings() { settings = current }
    }

    private func loadOwners() async {
        if let active = try? await client.ownerModes() { owners = active }
        if let ended = try? await client.ownerHistory() { ownerRecord = ended }
    }

    /// A Bot's or a group's name: the app's own list first (a group may be named after its members).
    private func ownerTitle(_ entry: LearningOwnerStatus) -> String {
        let team = app.botTeam
        if entry.kind == "room", let room = team.room(entry.id) { return team.name(of: room) }
        if entry.kind == "bot", let bot = team.bot(entry.id) { return bot.name }
        return entry.name ?? entry.id
    }

    private func openOwner(_ owner: LearningOwner) {
        switch owner {
        case .bot(let id): app.botTeam.openRequest = BotOpenRequest(route: .bot(id))
        case .room(let id): app.botTeam.openRequest = BotOpenRequest(route: .room(id))
        case .session(let id): open(id)
        }
    }

    /// Put a Bot or a group in `mode`, then (by default) open its chat.
    private func learn(_ owner: LearningOwner, in mode: LearningMode, open: Bool = true) async {
        do {
            try await client.set(mode, for: owner)
            Haptics.select()
            await LearningModes.shared.refresh(owner, client: client)
            await loadOwners()
            if open { openOwner(owner) }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func endOwner(_ entry: LearningOwnerStatus) async {
        do {
            try await client.set(nil, for: entry.owner)
            await LearningModes.shared.refresh(entry.owner, client: client)
            await loadOwners()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func hideOwner(_ entry: LearningOwnerStatus) async {
        do {
            try await client.hideOwner(kind: entry.kind, id: entry.id)
            ownerRecord.removeAll { $0 == entry }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func sessionTitle(_ id: String) -> String {
        let title = app.sessions[id]?.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return title.isEmpty ? String(localized: "新会话") : title
    }

    private func open(_ sessionId: String) {
        if let openSession { openSession(sessionId) }
        else { app.showToast(String(localized: "学习会话已建好，可在会话列表中打开")) }
    }

    private func endMode(_ sessionId: String) async {
        do {
            try await client.setMode(nil, for: sessionId)
            await LearningModes.shared.refresh(.session(sessionId), client: client)
            learningSessions.removeAll { $0.sessionId == sessionId }
            if let ended = try? await client.learningHistory() { history = ended }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func hide(_ sessionId: String) async {
        do {
            try await client.hideFromHistory(sessionId)
            history.removeAll { $0.sessionId == sessionId }
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
