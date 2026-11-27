import XCTest
@testable import DshIOS

/// Batch 2's wire format (Learning/LearningModeViews.swift, QuizViews.swift), against replies
/// shaped like engine/plugins/learning/index.mjs `owners.*` sends. No engine runs here.
final class LearningOwnerTests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testDecodesAGroupWithItsTeacher() throws {
        let reply = #"{"ok":true,"result":{"kind":"room","id":"room-g3","mode":"socratic","updatedAt":1,"endedAt":null,"name":"高三","teacher":{"id":"bot-hei","name":"嘿"},"paused":false}}"#
        let status = try LearningAPI.decode(LearningOwnerStatus.self, data: data(reply), status: 200)
        XCTAssertEqual(status.mode, .socratic)
        XCTAssertEqual(status.teacher?.name, "嘿")
        XCTAssertEqual(status.owner, .room("room-g3"))
        XCTAssertNil(status.endedDate)
    }

    func testDecodesABotNotInAModeAndAPausedGroup() throws {
        let bot = #"{"ok":true,"result":{"kind":"bot","id":"bot-hei","mode":null,"updatedAt":null,"endedAt":null,"name":"嘿"}}"#
        let none = try LearningAPI.decode(LearningOwnerStatus.self, data: data(bot), status: 200)
        XCTAssertNil(none.mode)
        XCTAssertEqual(none.owner, .bot("bot-hei"))
        let paused = #"{"ok":true,"result":{"kind":"room","id":"r","mode":"qa","updatedAt":1,"endedAt":null,"name":"g","paused":true}}"#
        let group = try LearningAPI.decode(LearningOwnerStatus.self, data: data(paused), status: 200)
        XCTAssertEqual(group.paused, true)
        XCTAssertNil(group.teacher)
    }

    func testDecodesTheRecord() throws {
        let reply = #"{"ok":true,"result":[{"kind":"room","id":"r","mode":"quiz","updatedAt":2,"endedAt":1795714937000,"name":"g"}]}"#
        let record = try LearningAPI.decode([LearningOwnerStatus].self, data: data(reply), status: 200)
        XCTAssertEqual(record.first?.endedDate, Date(timeIntervalSince1970: 1_795_714_937))
    }

    func testAGroupWithoutAnAdminIsRefusedWithTheEngineMessage() {
        let reply = #"{"error":{"kind":"conflict","message":"the group has no admin; set one in the group's details first"}}"#
        XCTAssertThrowsError(try LearningAPI.decode(LearningOwnerStatus.self, data: data(reply), status: 409)) { error in
            XCTAssertTrue(error.localizedDescription.contains("admin"))
        }
    }

    func testAQuestionKeepsWhereItWasAsked() throws {
        let reply = #"{"ok":true,"result":[{"id":1,"kind":"short","prompt":"p","options":[],"answer":null,"explanation":null,"topic":"","source":"model","attempts":0,"lastVerdict":null,"inMistakes":false,"mistakeStreak":null,"createdAt":1,"sessionId":"s-g3-hei"}]}"#
        let list = try LearningAPI.decode([QuizQuestion].self, data: data(reply), status: 200)
        XCTAssertEqual(list.first?.sessionId, "s-g3-hei")
    }
}
