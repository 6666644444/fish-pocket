import XCTest
@testable import DshIOS

/// 今日复习, 学习统计, the 错题复习 widget's copy and the Bot page's cold-start list (D53, D54),
/// against replies shaped like engine/plugins/learning/store.mjs sends. No engine runs here.
final class ReviewTests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testDecodesTodaysReview() throws {
        let reply = #"{"ok":true,"result":{"now":1000,"tzOffset":480,"due":1,"total":2,"dueTimes":[900,5000],"questions":[{"id":3,"kind":"choice","prompt":"2+2=?","options":["3","4"],"topic":"","source":"model","sessionId":null,"createdAt":1,"attempts":1,"lastVerdict":"incorrect","inMistakes":true,"mistakeStreak":0,"reviewAt":900}]}}"#
        let review = try LearningAPI.decode(QuizReview.self, data: data(reply), status: 200)
        XCTAssertEqual(review.due, 1)
        XCTAssertEqual(review.dueTimes, [900, 5000])
        XCTAssertEqual(review.questions.first?.reviewAt, 900)
    }

    func testAnOldReplyWithoutReviewDatesStillDecodes() throws {
        let reply = #"{"ok":true,"result":{"questionId":3,"verdict":"correct","score":1,"gradedBy":"rule","correctAnswer":"B","explanation":"","mistakeBook":"in","streak":1,"mastery":2}}"#
        let result = try LearningAPI.decode(QuizResult.self, data: data(reply), status: 200)
        XCTAssertNil(result.dueAt)
        XCTAssertNil(result.early)
        XCTAssertFalse(QuizText.book(result).isEmpty)
    }

    func testAnEarlyAnswerSaysItDidNotCount() throws {
        let due = (Date.now.timeIntervalSince1970 + 3 * 86_400) * 1000
        let early = #"{"ok":true,"result":{"questionId":3,"verdict":"correct","score":1,"gradedBy":"rule","correctAnswer":"B","explanation":"","mistakeBook":"in","streak":1,"dueAt":\#(due),"early":true,"mastery":3}}"#
        let onTime = early.replacingOccurrences(of: #","early":true"#, with: "")
        let a = try LearningAPI.decode(QuizResult.self, data: data(early), status: 200)
        let b = try LearningAPI.decode(QuizResult.self, data: data(onTime), status: 200)
        XCTAssertEqual(a.early, true)
        XCTAssertNotEqual(QuizText.book(a), QuizText.book(b))
        XCTAssertEqual(QuizText.review(0), String(localized: "今天复习"), "a past date is due today")
    }

    func testDecodesStats() throws {
        let reply = #"{"ok":true,"result":{"now":1,"tzOffset":480,"days":[{"day":0,"attempts":2,"correct":1}],"streakDays":3,"studiedToday":true,"totals":{"questions":2,"attempts":4,"correct":2,"mistakes":1,"dueNow":1,"dueThisWeek":1,"mastered":0,"notes":0,"memories":0,"documents":0,"research":0},"topics":[{"topic":"算术","questions":1,"attempts":3,"correct":1,"mistakes":1}]}}"#
        let stats = try LearningAPI.decode(LearningStats.self, data: data(reply), status: 200)
        XCTAssertEqual(stats.streakDays, 3)
        XCTAssertEqual(stats.days.first?.attempts, 2)
        XCTAssertEqual(stats.topics.first?.topic, "算术")
    }

    func testTheWidgetCountsAsDaysGoBy() {
        let snapshot = ReviewSnapshot(dueTimes: [1_000, 1_000, 90_000_000], prompts: ["p"], writtenAt: .now)
        XCTAssertEqual(snapshot.due(at: Date(timeIntervalSince1970: 0.5)), 0)
        XCTAssertEqual(snapshot.due(at: Date(timeIntervalSince1970: 1)), 2)
        XCTAssertEqual(snapshot.due(at: Date(timeIntervalSince1970: 90_000)), 3)
        XCTAssertEqual(snapshot.nextChange(after: Date(timeIntervalSince1970: 0)), Date(timeIntervalSince1970: 1))
        XCTAssertEqual(snapshot.nextChange(after: Date(timeIntervalSince1970: 1)), Date(timeIntervalSince1970: 90_000))
        XCTAssertNil(snapshot.nextChange(after: Date(timeIntervalSince1970: 90_000)))
        XCTAssertTrue(ReviewSnapshot.empty.unset)
    }

    func testTheReviewLinkRoundTrips() {
        XCTAssertEqual(DshLink(url: DshLink.review.url), .review)
        XCTAssertEqual(DshLink.review.url.host(), "review")
    }

    func testTheTimeZoneGoesAsMinutesEastOfUTC() {
        XCTAssertEqual(LearningClient.tzOffset, .number(Double(TimeZone.current.secondsFromGMT() / 60)))
    }
}
