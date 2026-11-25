import XCTest
@testable import DshIOS

/// Deep research's wire format (Learning/ResearchViews.swift), against replies shaped like
/// engine/plugins/learning/store.mjs sends. No engine runs here.
final class ResearchAPITests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    private let running = #"{"ok":true,"result":{"id":2,"sessionId":"s","topic":"算盘的历史","depth":"standard","sources":["web","kb"],"language":null,"target":{"provider":"deepseek","model":"deepseek-chat"},"status":"running","phase":"researching","progress":"researching 2/4: 起源","cancelRequested":false,"callsUsed":17,"blocks":4,"blocksDone":1,"citations":9,"error":null,"report":null,"createdAt":1,"updatedAt":2}}"#

    func testDecodesARunningJob() throws {
        let job = try LearningAPI.decode(ResearchJob.self, data: data(running), status: 200)
        XCTAssertTrue(job.isActive)
        XCTAssertFalse(job.canResume)
        XCTAssertEqual(job.sources, ["web", "kb"])
        XCTAssertNil(job.report)
        XCTAssertFalse(ResearchText.status(job).isEmpty)
    }

    func testDecodesAListWithoutReportsAndAPausedJob() throws {
        let list = #"{"ok":true,"result":[{"id":3,"sessionId":null,"topic":"t","depth":"quick","sources":["kb"],"language":null,"target":null,"status":"paused","phase":"writing","progress":"","cancelRequested":false,"callsUsed":20,"blocks":2,"blocksDone":2,"citations":4,"error":null,"createdAt":1,"updatedAt":2}]}"#
        let jobs = try LearningAPI.decode([ResearchJob].self, data: data(list), status: 200)
        XCTAssertEqual(jobs.first?.canResume, true)
        XCTAssertNil(jobs.first?.sessionId)
    }

    func testDecodesClaimsAndStartReplies() throws {
        let claims = #"{"ok":true,"result":[{"key":"verify:1:claim:1","claim":"x","status":"conflicting","note":"n","citations":["CIT-a"]}]}"#
        let decoded = try LearningAPI.decode([ResearchClaim].self, data: data(claims), status: 200)
        XCTAssertEqual(decoded.first?.status, "conflicting")
        XCTAssertNotEqual(ResearchText.claim("conflicting"), ResearchText.claim("corroborated"))
        let started = try LearningAPI.decode(ResearchStarted.self, data: data(#"{"ok":true,"result":{"started":false,"reason":"done","job":{}}}"#), status: 200)
        XCTAssertFalse(started.started)
        XCTAssertEqual(started.reason, "done")
    }

    func testReportMarkdownKeepsTextAndLinks() {
        let rendered = ResearchJobPage.markdown("# T\n\nFact [1].\n\n1. A — https://example.com")
        XCTAssertTrue(String(rendered.characters).contains("Fact [1]."))
        XCTAssertTrue(String(rendered.characters).contains("https://example.com"))
    }

    func testSettingsDecodeWithAndWithoutResearchWeb() throws {
        let all = try LearningAPI.decode(LearningSettings.self, data: data(#"{"ok":true,"result":{"injectMemories":true,"appleEmbedding":true,"researchWeb":false}}"#), status: 200)
        XCTAssertEqual(all.researchWeb, false)
        let old = try LearningAPI.decode(LearningSettings.self, data: data(#"{"ok":true,"result":{"injectMemories":true}}"#), status: 200)
        XCTAssertNil(old.researchWeb)
    }
}
