import XCTest
@testable import DshIOS

/// Shared/AppGroup.swift: which App Group the app and its extensions use when a signing tool
/// (a free Apple ID through AltStore, SideStore, AltLoad) signed them with groups of its own.
final class AppGroupTests: XCTestCase {
    private func profile(groups: [String]) -> Data {
        let list = groups.map { "<string>\($0)</string>" }.joined()
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>Name</key><string>p</string><key>Entitlements</key><dict>
        <key>application-identifier</key><string>T.x</string>
        <key>com.apple.security.application-groups</key><array>\(list)</array></dict></dict></plist>
        """
        // A signed profile wraps the plist in binary CMS bytes on both sides.
        return Data([0x30, 0x82, 0x01, 0x00, 0xFF]) + Data(plist.utf8) + Data([0x00, 0xA0, 0x82])
    }

    func testReadsTheGroupsOutOfASignedProfile() {
        XCTAssertEqual(AppGroup.profileGroups(in: profile(groups: ["group.a", "group.b"])), ["group.a", "group.b"])
        XCTAssertEqual(AppGroup.profileGroups(in: Data("not a profile".utf8)), [])
    }

    func testTheBuiltNameWinsWhenItOpens() {
        let r = AppGroup.resolve(declared: "group.com.firefly.learn.2gafst", profileGroups: ["group.other", "group.com.firefly.learn.2gafst"], opens: { _ in true })
        XCTAssertEqual(r.id, "group.com.firefly.learn.2gafst")
        XCTAssertEqual(r.source, .infoPlist)
    }

    func testARenamedGroupFromTheProfileIsUsedWhenTheBuiltOneDoesNotOpen() {
        let renamed = "group.com.firefly.learn.2gafst.ABCDE12345"
        let r = AppGroup.resolve(declared: "group.com.firefly.learn.2gafst", profileGroups: ["group.zzz", renamed, "group.aaa"], opens: { $0 != "group.com.firefly.learn.2gafst" })
        XCTAssertEqual(r.id, renamed, "a group containing the built name comes before the others")
        XCTAssertEqual(r.source, .profile)
    }

    func testTheOrderIsTheSameWhateverOrderTheProfileListsThem() {
        let a = AppGroup.candidates(declared: "group.x", profileGroups: ["group.c", "group.b", "group.x.T"])
        let b = AppGroup.candidates(declared: "group.x", profileGroups: ["group.x.T", "group.b", "group.c"])
        XCTAssertEqual(a, b)
        XCTAssertEqual(a, ["group.x", "group.x.T", "group.b", "group.c"])
        XCTAssertEqual(AppGroup.candidates(declared: nil, profileGroups: ["group.*", "com.not.a.group", "group.b"]), ["group.b"], "wildcards and non-groups are skipped")
    }

    func testNoneOpensSaysSo() {
        let r = AppGroup.resolve(declared: "group.x", profileGroups: [], opens: { _ in false })
        XCTAssertNil(r.id)
        XCTAssertEqual(r.source, .none)
        XCTAssertTrue(AppGroup.describe(r).contains("group.x"))
    }
}
