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
}
