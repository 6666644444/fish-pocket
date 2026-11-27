import XCTest
@testable import DshIOS

/// Firefly 伙伴's wire format (Learning/CompanionViews.swift), against replies shaped like
/// engine/plugins/learning/companion-runtime.mjs sends. No engine runs here.
final class CompanionTests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    func testDecodesStatusWithAndWithoutACompanion() throws {
        let none = #"{"ok":true,"result":{"settings":{"botId":"","reach":true,"quietStart":23,"quietEnd":8},"botName":null,"traits":[],"mood":null,"episodes":0,"planned":null}}"#
        let empty = try LearningAPI.decode(CompanionStatus.self, data: data(none), status: 200)
        XCTAssertTrue(empty.settings.botId.isEmpty)
        XCTAssertNil(empty.planned)
        let some = #"{"ok":true,"result":{"settings":{"botId":"b1","reach":true,"quietStart":23,"quietEnd":8},"botName":"小萤","traits":[{"key":"压力来时","text":"紧张时爱自嘲","evidence":"…","days":[1,2],"firstSeen":1,"lastSeen":2,"refuted":false}],"mood":{"word":"紧张","valence":-0.4,"at":5},"episodes":3,"planned":{"id":4,"botId":"b1","fireAt":9000,"text":"考得怎么样？","status":"planned","createdAt":1,"deliveredAt":null,"answeredAt":null,"ignored":false}}}"#
        let status = try LearningAPI.decode(CompanionStatus.self, data: data(some), status: 200)
        XCTAssertEqual(status.traits.first?.days.count, 2)
        XCTAssertEqual(status.mood?.word, "紧张")
        XCTAssertEqual(status.planned?.text, "考得怎么样？")
    }

    func testDecodesEpisodesPlanAndWake() throws {
        let list = #"{"ok":true,"result":[{"id":1,"botId":"b1","text":"那天晚上 ta 说月考没考好","cues":["月考"],"importance":0.7,"emotion":0.6,"mood":"沮丧","key":"","followUp":"","happenedAt":1,"createdAt":1,"recalls":2,"lastRecalledAt":null,"followedUpAt":null,"supersededBy":null,"hidden":false}]}"#
        XCTAssertEqual(try LearningAPI.decode([CompanionEpisode].self, data: data(list), status: 200).first?.recalls, 2)
        let skip = #"{"ok":true,"result":{"skip":"dice"}}"#
        let plan = try LearningAPI.decode(CompanionPlan.self, data: data(skip), status: 200)
        XCTAssertNil(plan.plan)
        XCTAssertEqual(plan.skip, "dice")
        let wake = #"{"ok":true,"result":{"delivered":[4],"expired":[],"cancelled":[2,3]}}"#
        XCTAssertEqual(try LearningAPI.decode(CompanionWake.self, data: data(wake), status: 200).cancelled, [2, 3])
    }

    func testTheNotificationOpensTheCompanionsChat() {
        XCTAssertEqual(DshLink(url: DshLink.bot("b1").url), .bot("b1"))
        XCTAssertTrue(CompanionNotifications.prefix.hasPrefix("firefly-"))
    }

    func testDecodesAGroupReachAndGroupSettings() throws {
        let plan = #"{"ok":true,"result":{"plan":{"id":7,"botId":"bot-hei","roomId":"room-g3","fireAt":9000,"text":"早，昨晚谁最后睡的？","status":"planned","createdAt":1,"deliveredAt":null,"answeredAt":null,"ignored":false,"botName":"嘿","roomName":"高三","sessionId":"s-room"}}}"#
        let reach = try XCTUnwrap(try LearningAPI.decode(CompanionPlan.self, data: data(plan), status: 200).plan)
        XCTAssertEqual(reach.roomName, "高三")
        XCTAssertEqual(reach.sessionId, "s-room")
        let settings = #"{"ok":true,"result":{"botId":"","reach":true,"quietStart":23,"quietEnd":8,"groupAdmins":true,"groupRecallDm":false}}"#
        let decoded = try LearningAPI.decode(CompanionSettings.self, data: data(settings), status: 200)
        XCTAssertEqual(decoded.groupAdmins, true)
        XCTAssertEqual(decoded.groupRecallDm, false)
        let episode = #"{"ok":true,"result":[{"id":1,"botId":"bot-hei","text":"在群里 ta 约我们去爬山","cues":["爬山"],"importance":0.7,"emotion":0.6,"mood":"","key":"","followUp":"","happenedAt":1,"createdAt":1,"recalls":0,"lastRecalledAt":null,"followedUpAt":null,"supersededBy":null,"hidden":false,"scope":"room:room-g3"}]}"#
        XCTAssertEqual(try LearningAPI.decode([CompanionEpisode].self, data: data(episode), status: 200).first?.scope, "room:room-g3")
    }
}
