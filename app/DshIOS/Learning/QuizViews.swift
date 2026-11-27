import SwiftUI

// Settings → 学习 → 题库与错题本 (milestone 4). The model writes and grades questions in a quiz
// session through the engine's `learning_quiz` tool; here the learner sees the bank, redoes
// the questions in the mistake book, and can overrule a grade. Grading is the engine's
// (engine/plugins/learning/quiz.mjs). Only system styles; not looked at on a device yet.

struct QuizQuestion: Codable, Identifiable, Hashable, Sendable {
    let id: Int
    /// "choice" or "short".
    let kind: String
    let prompt: String
    let options: [String]
    /// Only when asked for (`quiz.questions.get`).
    let answer: String?
    let explanation: String?
    let topic: String
    let source: String
    let attempts: Int
    /// "correct", "partial", "incorrect" or nil.
    let lastVerdict: String?
    let inMistakes: Bool
    /// Correct answers in a row since it went into the mistake book.
    let mistakeStreak: Int?
    /// When a question in the mistake book is next up for review (ms since 1970); nil out of it.
    var reviewAt: Double?
    let createdAt: Double
    /// The conversation it was asked in; a Bot's or a group's names it in the list (batch 2).
    var sessionId: String?

    static func letter(_ index: Int) -> String { String(UnicodeScalar(UInt8(65 + index))) }
}

struct QuizTopic: Codable, Hashable, Sendable {
    let topic: String
    let questions: Int
    let mistakes: Int
}

struct QuizResult: Codable, Hashable, Sendable {
    let questionId: Int
    let verdict: String
    let score: Double
    let gradedBy: String
    let chosen: String?
    let correctAnswer: String
    let explanation: String
    /// "added", "in", "removed" or "not-in".
    let mistakeBook: String
    let streak: Int?
    let mastery: Int
    /// Its next review, while it stays in the mistake book (D53).
    var dueAt: Double?
    /// Right, but before its review day: it did not count.
    var early: Bool?
}

extension LearningClient {
    func questions(mistakes: Bool = false, topic: String? = nil) async throws -> [QuizQuestion] {
        var params: [String: JSON] = ["mistakes": .bool(mistakes), "limit": 200]
        if let topic { params["topic"] = .string(topic) }
        return try await call("quiz.questions.list", params)
    }
    func question(_ id: Int) async throws -> QuizQuestion { try await call("quiz.questions.get", ["id": .number(Double(id))]) }
    func quizTopics() async throws -> [QuizTopic] { try await call("quiz.topics") }
    func deleteQuestion(_ id: Int) async throws {
        _ = try await call("quiz.questions.delete", ["id": .number(Double(id))], as: LearningDeleted.self)
    }
    func answer(_ id: Int, with answer: String) async throws -> QuizResult {
        try await call("quiz.answer", ["id": .number(Double(id)), "answer": .string(answer), "tzOffset": Self.tzOffset])
    }
    /// The learner overrules the grade of their last answer.
    func overrule(_ id: Int, answer: String, as verdict: String) async throws -> QuizResult {
        try await call("quiz.answer", ["id": .number(Double(id)), "answer": .string(answer), "judged": .string(verdict), "gradedBy": "user", "tzOffset": Self.tzOffset])
    }
}

enum QuizText {
    static func verdict(_ verdict: String?) -> String {
        switch verdict {
        case "correct": String(localized: "答对")
        case "partial": String(localized: "部分正确")
        case "incorrect": String(localized: "答错")
        default: String(localized: "未作答")
        }
    }

    static func book(_ result: QuizResult) -> String {
        switch result.mistakeBook {
        case "added":
            return String(localized: "已加入错题本，明天复习。")
        case "removed":
            return String(localized: "连续答对 \(result.mastery) 次，已移出错题本。")
        case "in":
            guard let due = result.dueAt else {
                return String(localized: "还在错题本里（已连续答对 \(result.streak ?? 0)/\(result.mastery) 次）。")
            }
            if result.early == true {
                return String(localized: "还没到复习时间，这次不计入，\(day(due))再复习。")
            }
            return String(localized: "还在错题本里（已连续答对 \(result.streak ?? 0)/\(result.mastery) 次），\(day(due))再复习。")
        default:
            return ""
        }
    }

    /// 「今天」「明天」 or the date, for a review day (ms since 1970).
    static func day(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        if date <= .now || Calendar.current.isDateInToday(date) { return String(localized: "今天") }
        if Calendar.current.isDateInTomorrow(date) { return String(localized: "明天") }
        return date.formatted(.dateTime.month().day())
    }

    /// When a question in the mistake book is next up: 「今天复习」 once due, else its day.
    static func review(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000) <= .now ? String(localized: "今天复习") : String(localized: "\(day(ms))复习")
    }
}

struct QuizBankPage: View {
    @Environment(AppModel.self) private var app

    /// The Bot or group a question was asked by, when it came from the Bot team.
    private func askedIn(_ question: QuizQuestion) -> String? {
        guard let sessionId = question.sessionId else { return nil }
        let team = app.botTeam
        switch team.route(ofSession: sessionId) {
        case .bot(let id)?: return team.bot(id)?.name
        case .room(let id)?: return team.room(id).map { team.name(of: $0) }
        case nil: return nil
        }
    }
    @State private var showMistakes = true
    @State private var questions: [QuizQuestion] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var practicing: QuizQuestion?
    @State private var deleting: QuizQuestion?

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            Section {
                Picker("显示", selection: $showMistakes) {
                    Text("错题本").tag(true)
                    Text("全部题目").tag(false)
                }
                .pickerStyle(.segmented)
            } footer: {
                Text("在「出题测验」模式里做的题会自动存进题库。答错的题进入错题本，第二天复习，之后隔 3 天、7 天各复习一次，到时间都答对就移出；没到复习时间答对不计入。")
            }
            Section {
                if !loaded {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let loadError {
                    Text(loadError).font(.footnote).foregroundStyle(.red)
                } else if questions.isEmpty {
                    if showMistakes {
                        Text("错题本是空的。").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text("题库里还没有题目。").font(.footnote).foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(questions) { question in
                        Button { practicing = question } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(question.prompt).foregroundStyle(.primary).lineLimit(3)
                                HStack(spacing: 8) {
                                    Text(question.kind == "choice" ? "单选" : "简答")
                                    if !question.topic.isEmpty { Text(question.topic) }
                                    if let from = askedIn(question) { Text(verbatim: from) }
                                    Text(QuizText.verdict(question.lastVerdict))
                                    if let streak = question.mistakeStreak { Text("连对 \(streak)") }
                                    if let reviewAt = question.reviewAt { Text(verbatim: QuizText.review(reviewAt)) }
                                }
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions { Button("删除", role: .destructive) { deleting = question } }
                    }
                }
            }
        }
        .groupedList()
        .navigationTitle("题库与错题本")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $practicing, onDismiss: { Task { await load() } }) { question in
            NavigationStack { QuizPracticePage(questionId: question.id) }
        }
        .confirmationDialog(
            "删除这道题？",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            titleVisibility: .visible,
            presenting: deleting
        ) { question in
            Button("删除题目和作答记录", role: .destructive) { Task { await delete(question) } }
        }
        .task(id: showMistakes) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            questions = try await client.questions(mistakes: showMistakes)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }

    private func delete(_ question: QuizQuestion) async {
        Haptics.firm()
        do {
            try await client.deleteQuestion(question.id)
            questions.removeAll { $0.id == question.id }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}

/// One question: answer it, see the grade and the explanation, overrule a short-answer grade.
/// In 今日复习 (`onNext`) it is one of a row: 「下一题」 instead of 「再做一次」.
struct QuizPracticePage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let questionId: Int
    /// "2/5" in a review.
    var position: String?
    /// Each grade, an overruled one included.
    var onResult: ((QuizResult) -> Void)?
    var onNext: (() -> Void)?
    @State private var question: QuizQuestion?
    @State private var choice: Int?
    @State private var text = ""
    @State private var result: QuizResult?
    @State private var submitted = ""
    @State private var working = false

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        Form {
            if let question {
                Section {
                    Text(question.prompt)
                }
                Section {
                    if question.kind == "choice" {
                        ForEach(Array(question.options.enumerated()), id: \.offset) { index, option in
                            Button { choice = index } label: {
                                HStack {
                                    Text("\(QuizQuestion.letter(index)). \(option)").foregroundStyle(.primary)
                                    Spacer()
                                    if choice == index { Image(systemName: "checkmark") }
                                }
                            }
                            .disabled(result != nil)
                        }
                    } else {
                        TextField("你的答案", text: $text, axis: .vertical).lineLimit(2...6).disabled(result != nil)
                    }
                }
                if let result {
                    Section {
                        Text(QuizText.verdict(result.verdict)).font(.headline)
                        LabeledContent("参考答案") { Text(result.correctAnswer) }
                        if !result.explanation.isEmpty { Text(result.explanation).font(.callout) }
                        let book = QuizText.book(result)
                        if !book.isEmpty { Text(book).font(.footnote).foregroundStyle(.secondary) }
                    } footer: {
                        if question.kind == "short" && result.gradedBy == "rule" {
                            Text("简答题按关键词粗略判分。判得不对的话，可以在下面改判。")
                        }
                    }
                    if question.kind == "short" {
                        Section {
                            if result.verdict != "correct" { Button("其实我答对了") { Task { await overrule("correct") } } }
                            if result.verdict != "incorrect" { Button("其实我答错了") { Task { await overrule("incorrect") } } }
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                if result == nil {
                    Button("提交") { Task { await submit() } }.disabled(working || !canSubmit)
                } else if let onNext {
                    Button("下一题") { onNext() }
                } else {
                    Button("再做一次") { result = nil; choice = nil; text = "" }
                }
            }
        }
        .task {
            do { question = try await client.question(questionId) } catch { app.showToast(error.localizedDescription, tone: .warning); dismiss() }
        }
    }

    private var title: String {
        let kind = question?.kind == "choice" ? String(localized: "单选题") : String(localized: "简答题")
        return position.map { "\(kind) \($0)" } ?? kind
    }

    private var canSubmit: Bool {
        question?.kind == "choice" ? choice != nil : !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() async {
        guard let question else { return }
        let answer = question.kind == "choice" ? QuizQuestion.letter(choice ?? 0) : text
        working = true
        defer { working = false }
        do {
            result = try await client.answer(question.id, with: answer)
            submitted = answer
            if let result { onResult?(result) }
            if result?.verdict == "correct" { Haptics.select() } else { Haptics.firm() }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }

    private func overrule(_ verdict: String) async {
        guard let question else { return }
        do {
            result = try await client.overrule(question.id, answer: submitted, as: verdict)
            if let result { onResult?(result) }
        } catch {
            app.showToast(error.localizedDescription, tone: .warning)
        }
    }
}
