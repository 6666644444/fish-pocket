import XCTest
@testable import DshIOS

/// The learning routes' wire format (Learning/LearningAPI.swift), checked against replies shaped
/// like engine/plugins/learning/index.mjs sends. No engine runs here.
final class LearningAPITests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testPathIsUnderApiLearning() {
        XCTAssertEqual(LearningAPI.path("notes.search"), "api/learning/notes.search")
    }

    func testBodyEncodesParametersAsAnObject() throws {
        let body = try LearningAPI.body(["query": "函数", "notebookId": 3])
        let decoded = try JSON.parse(body)
        XCTAssertEqual(decoded["query"].string, "函数")
        XCTAssertEqual(decoded["notebookId"].int, 3)
    }

    func testDecodesNotebooks() throws {
        let reply = #"{"ok":true,"result":[{"id":1,"title":"高中数学","noteCount":2,"createdAt":1001,"updatedAt":1764000000123}]}"#
        let books = try LearningAPI.decode([LearningNotebook].self, data: data(reply), status: 200)
        XCTAssertEqual(books.count, 1)
        XCTAssertEqual(books[0].id, 1)
        XCTAssertEqual(books[0].title, "高中数学")
        XCTAssertEqual(books[0].noteCount, 2)
        XCTAssertEqual(books[0].updatedAt, 1_764_000_000_123)
    }

    func testDecodesSearchResultWithMode() throws {
        let reply = #"{"ok":true,"result":{"mode":"like","results":[{"id":7,"notebookId":1,"title":"二次函数","excerpt":"…二次函数的图像…","updatedAt":5}]}}"#
        let found = try LearningAPI.decode(LearningSearchResult.self, data: data(reply), status: 200)
        XCTAssertEqual(found.mode, "like")
        XCTAssertEqual(found.results.map(\.id), [7])
        XCTAssertEqual(found.results[0].excerpt, "…二次函数的图像…")
    }

    func testDecodesMemoryAndClearCount() throws {
        let memory = try LearningAPI.decode(
            LearningMemory.self,
            data: data(#"{"ok":true,"result":{"id":4,"content":"喜欢先看例题","source":"user","createdAt":1,"updatedAt":2}}"#),
            status: 200
        )
        XCTAssertEqual(memory.content, "喜欢先看例题")
        XCTAssertEqual(memory.source, "user")
        let cleared = try LearningAPI.decode(LearningCleared.self, data: data(#"{"ok":true,"result":{"deleted":3}}"#), status: 200)
        XCTAssertEqual(cleared.deleted, 3)
    }

    func testRouteErrorKeepsKindMessageAndStatus() {
        let reply = #"{"error":{"kind":"not-found","message":"no notebook 42"}}"#
        XCTAssertThrowsError(try LearningAPI.decode(LearningNotebook.self, data: data(reply), status: 404)) { error in
            XCTAssertEqual(error as? LearningError, LearningError(kind: "not-found", message: "no notebook 42", status: 404))
            XCTAssertEqual(error.localizedDescription, "no notebook 42")
        }
    }

    func testUnparseableReplyIsATransportError() {
        XCTAssertThrowsError(try LearningAPI.decode([LearningNote].self, data: data("<html>502</html>"), status: 502)) { error in
            let failure = error as? LearningError
            XCTAssertEqual(failure?.kind, "transport")
            XCTAssertEqual(failure?.status, 502)
        }
    }

    func testOkWithTheWrongShapeIsATransportError() {
        let reply = #"{"ok":true,"result":{"unexpected":true}}"#
        XCTAssertThrowsError(try LearningAPI.decode([LearningNotebook].self, data: data(reply), status: 200)) { error in
            XCTAssertEqual((error as? LearningError)?.kind, "transport")
        }
    }

    func testSuccessBodyWithAnErrorStatusIsNotTakenAsSuccess() {
        let reply = #"{"ok":true,"result":[]}"#
        XCTAssertThrowsError(try LearningAPI.decode([LearningNotebook].self, data: data(reply), status: 500))
    }

    // Milestone 2

    func testModesMatchTheEngineSkills() {
        XCTAssertEqual(LearningMode.allCases.map(\.rawValue), ["qa", "socratic", "quiz"])
        XCTAssertEqual(LearningMode.allCases.map(\.skill), ["learning-qa", "learning-socratic", "learning-quiz"])
        for mode in LearningMode.allCases {
            XCTAssertFalse(mode.title.isEmpty)
            XCTAssertFalse(mode.summary.isEmpty)
        }
    }

    func testDecodesSettings() throws {
        let settings = try LearningAPI.decode(LearningSettings.self, data: data(#"{"ok":true,"result":{"injectMemories":false}}"#), status: 200)
        XCTAssertEqual(settings, LearningSettings(injectMemories: false))
    }

    func testDecodesSessionModesAndANullMode() throws {
        let reply = #"{"ok":true,"result":[{"sessionId":"s-1","mode":"socratic","announced":null,"updatedAt":9}]}"#
        let modes = try LearningAPI.decode([LearningSessionMode].self, data: data(reply), status: 200)
        XCTAssertEqual(modes, [LearningSessionMode(sessionId: "s-1", mode: .socratic, updatedAt: 9)])
        let none = try LearningAPI.decode(LearningSessionMode?.self, data: data(#"{"ok":true,"result":null}"#), status: 200)
        XCTAssertNil(none)
    }

    func testAnUnknownModeIsATransportError() {
        let reply = #"{"ok":true,"result":{"sessionId":"s","mode":"lecture","updatedAt":1}}"#
        XCTAssertThrowsError(try LearningAPI.decode(LearningSessionMode?.self, data: data(reply), status: 200)) { error in
            XCTAssertEqual((error as? LearningError)?.kind, "transport")
        }
    }

    func testClearingAModeSendsNull() throws {
        let body = try JSON.parse(LearningAPI.body(["sessionId": "s", "mode": .null]))
        XCTAssertEqual(body["sessionId"].string, "s")
        guard case .null = body["mode"] else { return XCTFail("mode should be null, got \(body["mode"])") }
        XCTAssertTrue(body.object.keys.contains("mode"))
    }

    func testDecodesSkillsWithAndWithoutOptionalFields() throws {
        let list = #"{"ok":true,"result":[{"name":"agent-made","kind":"bundle","description":"d","managed":false,"valid":true},{"name":"exam-review","kind":"bundle","description":"复习","whenToUse":"考前","managed":true,"valid":true}]}"#
        let skills = try LearningAPI.decode([LearningSkill].self, data: data(list), status: 200)
        XCTAssertEqual(skills.map(\.name), ["agent-made", "exam-review"])
        XCTAssertNil(skills[0].whenToUse)
        XCTAssertNil(skills[0].body)
        XCTAssertFalse(skills[0].managed)
        XCTAssertEqual(skills[1].whenToUse, "考前")
        let one = ##"{"ok":true,"result":{"name":"exam-review","kind":"bundle","description":"复习","managed":true,"valid":true,"body":"# 复习\n问我三个问题"}}"##
        XCTAssertEqual(try LearningAPI.decode(LearningSkill.self, data: data(one), status: 200).body, "# 复习\n问我三个问题")
    }

    func testSkillConflictKeepsTheEngineMessage() {
        let reply = #"{"error":{"kind":"conflict","message":"a skill or file named exam-review already exists"}}"#
        XCTAssertThrowsError(try LearningAPI.decode(LearningSkill.self, data: data(reply), status: 409)) { error in
            XCTAssertEqual((error as? LearningError)?.kind, "conflict")
            XCTAssertEqual((error as? LearningError)?.status, 409)
        }
    }

    func testSkillNameRulesMatchTheEngine() {
        for name in ["ab", "a-b", "exam-review", "a1", "x"] { XCTAssertTrue(LearningSkillRules.isValidName(name), name) }
        for name in ["", "a--b", "-a", "a-", "A", "a_b", "中文", "learning-mine", String(repeating: "a", count: 65)] {
            XCTAssertFalse(LearningSkillRules.isValidName(name), name)
        }
    }
}
