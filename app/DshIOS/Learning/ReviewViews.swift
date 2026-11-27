import Charts
import SwiftUI
import WidgetKit

// 今日复习 and 学习统计 (D53). The engine keeps the review dates (engine/plugins/learning/quiz.mjs
// nextMistake: the next day after a wrong answer, then after 3 and 7 days); here the learner works
// through what is due, one question after another, and sees how the studying went. The widget's
// copy of the plan (Shared/ReviewCatalog.swift) is written from here.

struct QuizReview: Codable, Sendable {
    let now: Double
    /// Questions up for review now.
    let due: Int
    /// Questions in the mistake book.
    let total: Int
    /// When each question in the book comes due, soonest first.
    let dueTimes: [Double]
    let questions: [QuizQuestion]
}

struct LearningStats: Codable, Sendable {
    struct Day: Codable, Hashable, Sendable {
        /// The local day's start, ms since 1970.
        let day: Double
        let attempts: Int
        let correct: Int
    }

    struct Totals: Codable, Sendable {
        let questions: Int
        let attempts: Int
        let correct: Int
        let mistakes: Int
        let dueNow: Int
        let dueThisWeek: Int
        let mastered: Int
        let notes: Int
        let memories: Int
        let documents: Int
        let research: Int
    }

    struct Topic: Codable, Hashable, Sendable {
        let topic: String
        let questions: Int
        let attempts: Int
        let correct: Int
        let mistakes: Int
    }

    let days: [Day]
    let streakDays: Int
    let studiedToday: Bool
    let totals: Totals
    let topics: [Topic]
}

extension LearningClient {
    /// Minutes east of UTC: review days and stats days are the phone's days.
    static var tzOffset: JSON { .number(Double(TimeZone.current.secondsFromGMT() / 60)) }

    func review() async throws -> QuizReview {
        try await call("quiz.review", ["tzOffset": Self.tzOffset, "limit": 100])
    }

    func stats(days: Int = 14) async throws -> LearningStats {
        try await call("stats.get", ["tzOffset": Self.tzOffset, "days": .number(Double(days))])
    }
}

/// Keeps the widget's copy of the review plan.
@MainActor
enum LearningReviewSync {
    /// Read today's review and hand the widget its copy; nil when the engine did not answer.
    @discardableResult
    static func refresh(_ client: LearningClient) async -> QuizReview? {
        guard let review = try? await client.review() else { return nil }
        publish(review)
        return review
    }

    static func publish(_ review: QuizReview) {
        let snapshot = ReviewSnapshot(
            dueTimes: review.dueTimes,
            prompts: review.questions.prefix(3).map { String($0.prompt.replacingOccurrences(of: "\n", with: " ").prefix(80)) },
            writtenAt: .now
        )
        if ReviewCatalog.write(snapshot) { WidgetCenter.shared.reloadTimelines(ofKind: ReviewCatalog.widgetKind) }
    }
}

/// 今日复习: the questions due, one after another. Each answer is graded by the engine: one answered
/// wrong comes back tomorrow, one answered right moves on to its next review.
struct QuizReviewPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var queue: [QuizQuestion] = []
    @State private var index = 0
    @State private var loaded = false
    @State private var loadError: String?
    /// The verdict each question ended on, an overruled grade included.
    @State private var verdicts: [Int: String] = [:]

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        Group {
            if loaded, loadError == nil, index < queue.count {
                let question = queue[index]
                QuizPracticePage(
                    questionId: question.id,
                    position: "\(index + 1)/\(queue.count)",
                    onResult: { verdicts[question.id] = $0.verdict },
                    onNext: { withAnimation(.snappy) { index += 1 } }
                )
                .id(question.id)
            } else {
                status
                    .navigationTitle("今日复习")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            }
        }
        .task { await load() }
        // The widget's count follows what was just done.
        .onDisappear { Task { await LearningReviewSync.refresh(client) } }
    }

    @ViewBuilder
    private var status: some View {
        if !loaded {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            ContentUnavailableView {
                Label("读不到错题本", systemImage: "exclamationmark.triangle")
            } description: {
                Text(loadError)
            }
        } else if queue.isEmpty {
            ContentUnavailableView {
                Label("今天没有要复习的题", systemImage: "checkmark.seal")
            } description: {
                Text("答错的题第二天会出现在这里，之后隔 3 天、7 天再各复习一次。")
            }
        } else {
            let right = verdicts.values.filter { $0 == "correct" }.count
            ContentUnavailableView {
                Label("复习完了", systemImage: "checkmark.circle")
            } description: {
                Text("这次答对 \(right)/\(queue.count) 题。答错的明天再复习。")
            }
        }
    }

    private func load() async {
        guard !loaded else { return }
        do {
            let review = try await client.review()
            queue = review.questions
            LearningReviewSync.publish(review)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
        loaded = true
    }
}

/// 学习统计: the last two weeks of answers, days studied in a row, totals and topics.
struct LearningStatsPage: View {
    @Environment(AppModel.self) private var app
    @State private var stats: LearningStats?
    @State private var loadError: String?

    private var client: LearningClient { LearningClient(engine: app.client) }

    var body: some View {
        List {
            if let stats {
                overview(stats)
                chart(stats)
                totals(stats)
                topics(stats)
            } else if let loadError {
                Text(loadError).font(.footnote).foregroundStyle(.red)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .groupedList()
        .navigationTitle("学习统计")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            stats = try await client.stats(days: 14)
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// Rounded percent of right answers; nil before any answer.
    private func rate(_ correct: Int, of attempts: Int) -> Int? {
        attempts > 0 ? Int((Double(correct) / Double(attempts) * 100).rounded()) : nil
    }

    private func overview(_ stats: LearningStats) -> some View {
        Section {
            LabeledContent("连续学习") { Text("\(stats.streakDays) 天") }
            LabeledContent("今天要复习") { Text("\(stats.totals.dueNow) 题") }
            LabeledContent("未来 7 天要复习") { Text("\(stats.totals.dueThisWeek) 题") }
        } footer: {
            if !stats.studiedToday && stats.streakDays > 0 {
                Text("今天还没学习，做一道题、写一条笔记就能接上。")
            }
        }
    }

    private func chart(_ stats: LearningStats) -> some View {
        let right = String(localized: "答对")
        let wrong = String(localized: "没答对")
        return Section {
            Chart {
                ForEach(stats.days, id: \.day) { day in
                    let date = Date(timeIntervalSince1970: day.day / 1000)
                    BarMark(x: .value("日期", date, unit: .day), y: .value("题数", day.correct))
                        .foregroundStyle(by: .value("结果", right))
                    BarMark(x: .value("日期", date, unit: .day), y: .value("题数", day.attempts - day.correct))
                        .foregroundStyle(by: .value("结果", wrong))
                }
            }
            .chartForegroundStyleScale([right: Color.green, wrong: Color.orange])
            .chartXAxis {
                AxisMarks(values: .stride(by: .day, count: 2)) { _ in
                    AxisValueLabel(format: .dateTime.month(.defaultDigits).day(), centered: true)
                }
            }
            .frame(height: 180)
            .padding(.vertical, 6)
        } header: {
            Text("最近 14 天")
        } footer: {
            let attempts = stats.days.reduce(0) { $0 + $1.attempts }
            let correct = stats.days.reduce(0) { $0 + $1.correct }
            if let percent = rate(correct, of: attempts) {
                Text("这 14 天答题 \(attempts) 次，正确率 \(percent)%。")
            } else {
                Text("这 14 天还没有答过题。")
            }
        }
    }

    private func totals(_ stats: LearningStats) -> some View {
        let totals = stats.totals
        return Section("累计") {
            LabeledContent("题库") { Text("\(totals.questions) 题") }
            LabeledContent("作答") {
                if let percent = rate(totals.correct, of: totals.attempts) {
                    Text("\(totals.attempts) 次，正确率 \(percent)%")
                } else {
                    Text("\(totals.attempts) 次")
                }
            }
            LabeledContent("错题本") { Text("\(totals.mistakes) 题") }
            LabeledContent("已掌握的错题") { Text("\(totals.mastered) 题") }
            LabeledContent("笔记") { Text("\(totals.notes) 条") }
            LabeledContent("学习记忆") { Text("\(totals.memories) 条") }
            LabeledContent("知识库") { Text("\(totals.documents) 篇") }
            LabeledContent("完成的深度研究") { Text("\(totals.research) 个") }
        }
    }

    @ViewBuilder
    private func topics(_ stats: LearningStats) -> some View {
        if !stats.topics.isEmpty {
            Section {
                ForEach(stats.topics, id: \.topic) { topic in
                    VStack(alignment: .leading, spacing: 3) {
                        if topic.topic.isEmpty { Text("未分主题") } else { Text(verbatim: topic.topic) }
                        HStack(spacing: 8) {
                            Text("\(topic.questions) 题")
                            if let percent = rate(topic.correct, of: topic.attempts) {
                                Text("正确率 \(percent)%")
                            } else {
                                Text("还没作答")
                            }
                            if topic.mistakes > 0 { Text("错题 \(topic.mistakes)") }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } header: {
                Text("按主题")
            } footer: {
                Text("主题是出题时 Bot 给题目起的分类，最多列出 12 个。")
            }
        }
    }
}
