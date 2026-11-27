import XCTest
@testable import DshIOS

/// Shared/ShareInbox.swift: the share extension can send to a conversation already there (D51),
/// and a targets file an older app wrote still reads.
final class ShareTargetsTests: XCTestCase {
    func testASessionTargetRoundTrips() throws {
        let target = ShareInbox.Target.session("s-1")
        XCTAssertEqual(target.conversation, "session:s-1")
        XCTAssertEqual(ShareInbox.Target(conversation: "session:s-1"), target)
        XCTAssertNil(ShareInbox.Target(conversation: "session:"))
        let delivery = ShareInbox.Delivery(target: target, text: "hi", files: [], createdAt: Date(timeIntervalSince1970: 1))
        let decoded = try JSONDecoder().decode(ShareInbox.Delivery.self, from: JSONEncoder().encode(delivery))
        XCTAssertEqual(decoded.target, target)
    }

    func testTheOtherTargetsAreUnchanged() {
        XCTAssertEqual(ShareInbox.Target(conversation: "bot:b"), .bot("b"))
        XCTAssertEqual(ShareInbox.Target(conversation: "room:r"), .room("r"))
        XCTAssertNil(ShareInbox.Target(conversation: "new"))
        XCTAssertNil(ShareInbox.Target(conversation: "other:x"))
    }

    func testAnOlderFileHasNoConversations() throws {
        let old = #"{"bots":[{"id":"b","name":"测试","role":""}],"rooms":[],"order":["bot:b"]}"#
        let targets = try JSONDecoder().decode(ShareTargets.self, from: Data(old.utf8))
        XCTAssertEqual(targets.bots.map(\.id), ["b"])
        XCTAssertTrue(targets.sessions.isEmpty)
    }

    func testConversationsRoundTrip() throws {
        let targets = ShareTargets(bots: [], rooms: [], sessions: [
            .init(id: "s-1", title: "导数", workspace: "默认工作区"),
            .init(id: "s-2", title: "新会话", workspace: nil),
        ])
        let decoded = try JSONDecoder().decode(ShareTargets.self, from: JSONEncoder().encode(targets))
        XCTAssertEqual(decoded, targets)
        XCTAssertEqual(decoded.sessions.map(\.id), ["s-1", "s-2"])
        XCTAssertNil(decoded.sessions[1].workspace)
    }
}
