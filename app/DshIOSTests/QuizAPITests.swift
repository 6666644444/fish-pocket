import XCTest
@testable import DshIOS

/// The question bank's wire format (Learning/QuizViews.swift), against replies shaped like
/// engine/plugins/learning/store.mjs sends. No engine runs here.
final class QuizAPITests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testDecodesQuestionsWithAndWithoutTheAnswer() throws {
        let list = #"{"ok":true,"result":[{"id":3,"kind":"choice","prompt":"2+2=?","options":["3","4"],"topic":"算术","source":"model","sessionId":"s","createdAt":1,"attempts":2,"lastVerdict":"incorrect","inMistakes":true,"mistakeStreak":0}]}"#
        let questions = try LearningAPI.decode([QuizQuestion].self, data: data(list), status: 200)
        XCTAssertEqual(questions.first?.options, ["3", "4"])
        XCTAssertNil(questions.first?.answer)
        XCTAssertEqual(questions.first?.mistakeStreak, 0)
        let one = #"{"ok":true,"result":{"id":4,"kind":"short","prompt":"p","options":[],"answer":"ref","explanation":"","topic":"","source":"user","sessionId":null,"createdAt":1,"attempts":0,"lastVerdict":null,"inMistakes":false,"mistakeStreak":null}}"#
        let question = try LearningAPI.decode(QuizQuestion.self, data: data(one), status: 200)
        XCTAssertEqual(question.answer, "ref")
        XCTAssertNil(question.lastVerdict)
        XCTAssertFalse(question.inMistakes)
    }

    func testDecodesAGradeAndDescribesTheMistakeBook() throws {
        let reply = #"{"ok":true,"result":{"questionId":3,"verdict":"correct","score":1,"gradedBy":"rule","chosen":"B","correctAnswer":"B","explanation":"4","mistakeBook":"in","streak":1,"mastery":2}}"#
        let result = try LearningAPI.decode(QuizResult.self, data: data(reply), status: 200)
        XCTAssertEqual(result.chosen, "B")
        XCTAssertFalse(QuizText.book(result).isEmpty)
        let removed = #"{"ok":true,"result":{"questionId":3,"verdict":"correct","score":1,"gradedBy":"rule","correctAnswer":"B","explanation":"","mistakeBook":"removed","mastery":2}}"#
        let out = try LearningAPI.decode(QuizResult.self, data: data(removed), status: 200)
        XCTAssertNil(out.streak)
        XCTAssertNil(out.chosen)
        XCTAssertFalse(QuizText.book(out).isEmpty)
        let none = #"{"ok":true,"result":{"questionId":3,"verdict":"correct","score":1,"gradedBy":"rule","correctAnswer":"B","explanation":"","mistakeBook":"not-in","mastery":2}}"#
        XCTAssertEqual(QuizText.book(try LearningAPI.decode(QuizResult.self, data: data(none), status: 200)), "")
    }

    func testLettersAndVerdictText() {
        XCTAssertEqual((0..<4).map(QuizQuestion.letter), ["A", "B", "C", "D"])
        XCTAssertNotEqual(QuizText.verdict("correct"), QuizText.verdict("incorrect"))
        XCTAssertNotEqual(QuizText.verdict(nil), QuizText.verdict("partial"))
    }

    func testAnInvalidAnswerKeepsTheEngineMessage() {
        let reply = #"{"error":{"kind":"invalid","message":"answer with one option letter, A–D"}}"#
        XCTAssertThrowsError(try LearningAPI.decode(QuizResult.self, data: data(reply), status: 400)) { error in
            XCTAssertEqual(error.localizedDescription, "answer with one option letter, A–D")
        }
    }
}
