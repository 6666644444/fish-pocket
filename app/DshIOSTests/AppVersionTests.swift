import XCTest
@testable import DshIOS

/// 版本号比较（Core/UpdateChecker.swift 的 AppVersion）：更新检查和「新功能」弹窗都靠它。
final class AppVersionTests: XCTestCase {
    func testSegmentsStripPrefixAndSuffix() {
        XCTAssertEqual(AppVersion.segments("1.2.0"), [1, 2, 0])
        XCTAssertEqual(AppVersion.segments("v1.2.0"), [1, 2, 0])
        XCTAssertEqual(AppVersion.segments("V2.0"), [2, 0])
        XCTAssertEqual(AppVersion.segments("1.2.0-beta.1"), [1, 2, 0])
    }

    func testSegmentsRejectMalformed() {
        XCTAssertNil(AppVersion.segments("1..2"))
        XCTAssertNil(AppVersion.segments("abc"))
    }

    func testIsNewerComparesNumerically() {
        XCTAssertTrue(AppVersion.isNewer("1.10.0", than: "1.9.0"))
        XCTAssertFalse(AppVersion.isNewer("1.9.0", than: "1.10.0"))
        XCTAssertTrue(AppVersion.isNewer("v1.2.3", than: "1.2.2"))
    }

    func testIsNewerTreatsMissingSegmentsAsZero() {
        XCTAssertFalse(AppVersion.isNewer("1.0", than: "1.0.0"))
        XCTAssertFalse(AppVersion.isNewer("1.0.0", than: "1.0"))
        XCTAssertTrue(AppVersion.isNewer("1.0.1", than: "1.0"))
    }

    func testIsNewerIsFalseForUnparseable() {
        XCTAssertFalse(AppVersion.isNewer("abc", than: "1.0"))
        XCTAssertFalse(AppVersion.isNewer("1.0", than: "abc"))
    }
}
