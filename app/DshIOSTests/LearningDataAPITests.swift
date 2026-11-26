import XCTest
@testable import DshIOS

/// Learning data management's wire format (Learning/DataViews.swift), against replies shaped
/// like engine/plugins/learning/portable.mjs sends. No engine runs here.
final class LearningDataAPITests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testDecodesSummaryAndDescribesWhatDeletionRemoves() throws {
        let reply = #"{"ok":true,"result":{"notebooks":2,"notes":5,"memories":3,"documents":1,"questions":7,"mistakes":2,"research":4}}"#
        let summary = try LearningAPI.decode(LearningDataSummary.self, data: data(reply), status: 200)
        XCTAssertEqual(summary.notes, 5)
        let text = LearningDataText.scope(summary)
        XCTAssertTrue(text.contains("5"))
        XCTAssertTrue(text.contains("7"))
    }

    func testDecodesExportBackupsAndRestore() throws {
        let export = #"{"ok":true,"result":{"path":"/home/dsh/.dsh/learning/exports/learning-export-20261125-093000","notebooks":1,"notes":2,"memories":0,"documents":0,"questions":0,"research":1}}"#
        let exported = try LearningAPI.decode(LearningExport.self, data: data(export), status: 200)
        XCTAssertTrue(exported.path.hasPrefix("/home/dsh/.dsh/learning/exports/"))
        XCTAssertTrue(EnginePaths.real(exported.path).path.hasSuffix("learning/exports/learning-export-20261125-093000"))
        let list = #"{"ok":true,"result":[{"name":"learning-20261125-093000.db","bytes":167936}]}"#
        XCTAssertEqual(try LearningAPI.decode([LearningBackup].self, data: data(list), status: 200).first?.id, "learning-20261125-093000.db")
        let restored = #"{"ok":true,"result":{"restored":"learning-20261125-093000.db","schemaVersion":6,"previous":"learning-20261125-093100.db"}}"#
        XCTAssertEqual(try LearningAPI.decode(LearningRestored.self, data: data(restored), status: 200).schemaVersion, 6)
    }

    func testAnImportIntoAFullLibraryKeepsTheEngineMessage() {
        let reply = #"{"error":{"kind":"conflict","message":"the learning library is not empty"}}"#
        XCTAssertThrowsError(try LearningAPI.decode(JSON.self, data: data(reply), status: 409)) { error in
            XCTAssertEqual(error.localizedDescription, "the learning library is not empty")
        }
    }

    func testBackupsCarryTheirTimeAndKind() throws {
        let list = #"{"ok":true,"result":[{"name":"learning-2026-11-27-01-42-17-before-restore.db","bytes":1,"createdAt":1795714937000,"kind":"before-restore"},{"name":"learning-2026-11-27-01-40-00.db","bytes":2,"createdAt":1795714800000,"kind":"manual"}]}"#
        let backups = try LearningAPI.decode([LearningBackup].self, data: data(list), status: 200)
        XCTAssertEqual(backups.map(\.isBeforeRestore), [true, false])
        XCTAssertEqual(backups[0].date, Date(timeIntervalSince1970: 1_795_714_937))
    }

    func testDecodesTheLearningRecord() throws {
        let reply = #"{"ok":true,"result":[{"sessionId":"s1","mode":"socratic","endedAt":1795714937000,"updatedAt":1795714937000}]}"#
        let record = try LearningAPI.decode([LearningHistoryEntry].self, data: data(reply), status: 200)
        XCTAssertEqual(record.first?.mode, .socratic)
        XCTAssertEqual(record.first?.endedDate, Date(timeIntervalSince1970: 1_795_714_937))
    }

    func testTheLocalStampIsWhatTheEngineAccepts() {
        let stamp = LearningStamp.now()
        XCTAssertNotNil(stamp.range(of: #"^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$"#, options: .regularExpression), stamp)
    }
}
