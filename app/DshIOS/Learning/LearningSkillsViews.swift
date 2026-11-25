import SwiftUI

// Settings → 学习 → 我的 Skills (milestone 2). The user's own skills live where DSH already loads
// them from, `$DSH_HOME/skills/<name>/SKILL.md`; the engine's learning plugin reads and writes
// them (engine/plugins/learning/skills.mjs). Skills made here can be edited and deleted here;
// skills that were already in that folder (written by the agent, copied in) are shown read-only.

/// What the skill editor opens with: an existing skill made here, or a new one.
struct LearningSkillDraft: Identifiable {
    let id = UUID()
    /// nil for a new skill.
    var existing: String?
    var name: String
    var description: String
    var whenToUse: String
    var body: String
}

struct LearningSkillsPage: View {
    @Environment(AppModel.self) private var app
    @State private var skills: [LearningSkill] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var editing: LearningSkillDraft?
    @State private var reading: LearningSkill?
    @State private var deleting: LearningSkill?

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            Section {
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.red)
                } else if skills.isEmpty {
                    Text("还没有自己的 Skill。点右上角的 + 新建一个。").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(skills) { skill in
                        Button { Task { await open(skill) } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 6) {
                                    Text(skill.name).font(.body.monospaced()).foregroundStyle(.primary)
                                    if !skill.managed {
                                        Text("只读").font(.caption2).foregroundStyle(.secondary)
                                    }
                                    if !skill.valid {
                                        Text("格式有误").font(.caption2).foregroundStyle(.red)
                                    }
                                }
                                if !skill.description.isEmpty {
                                    Text(skill.description).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                                }
                            }
                        }
                        .swipeActions {
                            if skill.managed {
                                Button("删除", role: .destructive) { deleting = skill }
                            }
                        }
                    }
                }
            } footer: {
                Text("Skill 保存在 DSH 自己的 skills 文件夹里，所有会话都能用 /名称 调用，模型也会在需要时自己加载。标「只读」的不是在这里创建的，这里不修改它们；标「格式有误」的 DSH 不会加载。")
            }
        }
        .groupedList()
        .navigationTitle("我的 Skills")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    editing = LearningSkillDraft(existing: nil, name: "", description: "", whenToUse: "", body: "")
                } label: { Image(systemName: "plus") }
                    .accessibilityLabel("新建 Skill")
            }
        }
        .sheet(item: $editing) { draft in
            NavigationStack {
                LearningSkillEditor(draft: draft) { await load() }
            }
        }
        .sheet(item: $reading) { skill in
            NavigationStack { LearningSkillReader(skill: skill) }
        }
        .confirmationDialog(
            "删除这个 Skill？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { skill in
            Button("删除 \(skill.name)", role: .destructive) { Task { await delete(skill) } }
        } message: { _ in
            Text("会删除它的 SKILL.md 和所在的文件夹，删除后无法恢复。")
        }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            skills = try await client.skills()
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func open(_ skill: LearningSkill) async {
        do {
            let full = try await client.skill(skill.name)
            if full.managed {
                editing = LearningSkillDraft(
                    existing: full.name, name: full.name, description: full.description,
                    whenToUse: full.whenToUse ?? "", body: full.body ?? ""
                )
            } else {
                reading = full
            }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func delete(_ skill: LearningSkill) async {
        Haptics.firm()
        do {
            try await client.deleteSkill(skill.name)
            skills.removeAll { $0.name == skill.name }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// Writes or edits one skill made here; saves only when the user taps Save.
struct LearningSkillEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let draft: LearningSkillDraft
    let saved: () async -> Void
    @State private var name: String
    @State private var summary: String
    @State private var whenToUse: String
    @State private var text: String
    @State private var saving = false

    init(draft: LearningSkillDraft, saved: @escaping () async -> Void) {
        self.draft = draft
        self.saved = saved
        _name = State(initialValue: draft.name)
        _summary = State(initialValue: draft.description)
        _whenToUse = State(initialValue: draft.whenToUse)
        _text = State(initialValue: draft.body)
    }

    private var unchanged: Bool {
        name == draft.name && summary == draft.description && whenToUse == draft.whenToUse && text == draft.body
    }
    private var trimmedName: String { name.trimmingCharacters(in: .whitespaces) }
    private var nameOK: Bool { draft.existing != nil || LearningSkillRules.isValidName(trimmedName) }
    private var canSave: Bool {
        !saving && !unchanged && nameOK
            && !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        Form {
            Section {
                if draft.existing == nil {
                    TextField("名称", text: $name)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } else {
                    LabeledContent("名称") { Text(draft.name).font(.body.monospaced()) }
                }
            } footer: {
                if draft.existing == nil {
                    if !trimmedName.isEmpty && !nameOK {
                        Text("名称只能用小写字母、数字和单个连字符，例如 exam-review；不能以 learning- 开头。")
                            .foregroundStyle(.red)
                    } else {
                        Text("名称建好后不能修改，在会话里用 /名称 调用。")
                    }
                }
            }
            Section {
                TextField("一句话说明它做什么、什么时候用", text: $summary, axis: .vertical)
                    .lineLimit(2...4)
            } header: {
                Text("说明（必填）")
            } footer: {
                Text("模型靠这句话判断什么时候加载它。")
            }
            Section {
                TextField("可选", text: $whenToUse, axis: .vertical)
                    .lineLimit(1...3)
            } header: {
                Text("适用场景")
            }
            Section {
                TextEditor(text: $text)
                    .font(.body.monospaced())
                    .frame(minHeight: 240)
            } header: {
                Text("指令（Markdown）")
            }
        }
        .navigationTitle(draft.existing == nil ? "新建 Skill" : "编辑 Skill")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(!unchanged)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("取消") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }
                    .disabled(!canSave)
            }
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let client = LearningClient(engine: app.client)
        do {
            if let existing = draft.existing {
                _ = try await client.updateSkill(name: existing, description: summary, whenToUse: whenToUse, body: text)
            } else {
                _ = try await client.createSkill(name: trimmedName, description: summary, whenToUse: whenToUse, body: text)
            }
            await saved()
            dismiss()
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// A skill that was not made here, shown as it is.
struct LearningSkillReader: View {
    @Environment(\.dismiss) private var dismiss
    let skill: LearningSkill

    var body: some View {
        List {
            Section {
                LabeledContent("名称") { Text(skill.name).font(.body.monospaced()) }
                if !skill.description.isEmpty {
                    Text(skill.description).font(.footnote)
                }
                if let whenToUse = skill.whenToUse, !whenToUse.isEmpty {
                    LabeledContent("适用场景") { Text(whenToUse) }
                }
            } footer: {
                if skill.valid {
                    Text("这个 Skill 不是在这里创建的，这里只显示、不修改。")
                } else {
                    Text("这个 Skill 的开头格式有误（缺少 name 或 description），DSH 不会加载它。")
                }
            }
            Section {
                Text(skill.body ?? "")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            } header: {
                Text("指令")
            }
        }
        .groupedList()
        .navigationTitle(skill.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
    }
}
