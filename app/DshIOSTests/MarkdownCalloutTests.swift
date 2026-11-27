import XCTest
@testable import DshIOS

/// Views/MarkdownCallout.swift (D52): which quotes are callouts, their kind, title, folding and
/// body; a quote without the marker is the quote it always was.
final class MarkdownCalloutTests: XCTestCase {
    private func callouts(_ source: String) -> [MarkdownCallout] {
        MarkdownBlock.parse(source).compactMap { if case .callout(let callout) = $0 { callout } else { nil } }
    }

    private func quotes(_ source: String) -> [String] {
        MarkdownBlock.parse(source).compactMap { if case .quote(let text) = $0 { text } else { nil } }
    }

    func testGitHubAlertsAreCallouts() {
        for (marker, kind) in [("NOTE", MarkdownCallout.Kind.note), ("TIP", .tip), ("IMPORTANT", .important), ("WARNING", .warning), ("CAUTION", .caution)] {
            let found = callouts("> [!\(marker)]\n> Body text.")
            XCTAssertEqual(found.count, 1, marker)
            XCTAssertEqual(found.first?.kind, kind, marker)
            XCTAssertNil(found.first?.title, "the kind's own name is shown: \(marker)")
            XCTAssertEqual(found.first?.fold, .fixed)
            XCTAssertEqual(found.first?.body, "Body text.")
        }
    }

    func testNamesAreCaseInsensitiveAndObsidiansAreKnown() {
        XCTAssertEqual(callouts("> [!tip]\n> x").first?.kind, .tip)
        XCTAssertEqual(callouts("> [!Hint]\n> x").first?.kind, .tip)
        XCTAssertEqual(callouts("> [!danger]\n> x").first?.kind, .caution)
        XCTAssertEqual(callouts("> [!example]\n> x").first?.kind, .note)
        XCTAssertEqual(callouts("> [!attention]\n> x").first?.kind, .warning)
    }

    func testATitleAfterTheMarker() {
        let found = callouts("> [!TIP] 技巧\n> 配方找出最值")
        XCTAssertEqual(found.first?.kind, .tip)
        XCTAssertEqual(found.first?.title, "技巧")
        XCTAssertEqual(found.first?.body, "配方找出最值")
        XCTAssertEqual(callouts("> [!IMPORTANT] **重点**\n> x").first?.title, "重点", "emphasis around a title is dropped")
    }

    func testChineseNamesAreTheirOwnTitle() {
        let found = callouts("> [!易错]\n> 不要遗漏取等条件")
        XCTAssertEqual(found.first?.kind, .warning)
        XCTAssertEqual(found.first?.title, "易错")
        XCTAssertEqual(callouts("> [!重点]\n> x").first?.kind, .important)
        XCTAssertEqual(callouts("> [!技巧] 配方\n> x").first?.title, "配方", "a written title wins")
    }

    func testAnUnknownNameIsANoteHeadedByIt() {
        let found = callouts("> [!例题二]\n> 求最小值")
        XCTAssertEqual(found.first?.kind, .note)
        XCTAssertEqual(found.first?.title, "例题二")
        XCTAssertEqual(callouts("> [!custom]\n> x").first?.title, "custom")
    }

    func testFolding() {
        XCTAssertEqual(callouts("> [!NOTE]- 证明\n> x").first?.fold, .closed)
        XCTAssertEqual(callouts("> [!NOTE]- 证明\n> x").first?.title, "证明")
        XCTAssertEqual(callouts("> [!NOTE]+\n> x").first?.fold, .open)
        XCTAssertNil(callouts("> [!NOTE]+\n> x").first?.title)
    }

    func testTheBodyIsMarkdownWithItsIndentation() throws {
        let source = "> [!IMPORTANT] 结论\n> $$\n> \\boxed{y_{min}=-1}\n> $$\n> - 平方项非负\n>   - 取等：x=2\n>\n> > 引用"
        let callout = try XCTUnwrap(callouts(source).first)
        XCTAssertEqual(callout.body, "$$\n\\boxed{y_{min}=-1}\n$$\n- 平方项非负\n  - 取等：x=2\n\n> 引用")
        let inner = MarkdownBlock.parse(callout.body)
        XCTAssertTrue(inner.contains { if case .math = $0 { true } else { false } }, "a formula inside is a formula")
        XCTAssertTrue(inner.contains { if case .list(let items, _) = $0 { items.count == 2 && items[1].indent > 0 } else { false } }, "a nested list keeps its level")
        XCTAssertTrue(inner.contains { if case .quote(let text) = $0 { text == "引用" } else { false } })
    }

    func testATitleOnlyCalloutHasNoBody() {
        let found = callouts("> [!WARNING] 别忘了检验根")
        XCTAssertEqual(found.first?.title, "别忘了检验根")
        XCTAssertEqual(found.first?.body, "")
    }

    func testPlainQuotesStayQuotes() {
        XCTAssertEqual(quotes("> 学而时习之\n>   不亦说乎"), ["学而时习之\n不亦说乎"], "trimmed as before")
        XCTAssertTrue(callouts("> 学而时习之").isEmpty)
        XCTAssertEqual(quotes("> [!TI").count, 1, "a marker still being written is a quote")
        XCTAssertEqual(quotes("> [!]\n> x").count, 1, "no name, no callout")
        XCTAssertEqual(quotes("> [!see](https://example.com) a link").count, 1, "a link's text is not a marker")
        XCTAssertEqual(quotes("> [1] 参考文献").count, 1)
    }

    func testCalloutsSitAmongOtherBlocks() {
        let blocks = MarkdownBlock.parse("第一段\n\n> [!TIP]\n> 技巧\n\n> [!CAUTION]\n> 错误\n\n最后一段")
        XCTAssertEqual(blocks.count, 4)
        guard case .paragraph = blocks[0], case .callout(let a) = blocks[1], case .callout(let b) = blocks[2], case .paragraph = blocks[3] else {
            return XCTFail("\(blocks)")
        }
        XCTAssertEqual(a.kind, .tip)
        XCTAssertEqual(b.kind, .caution)
    }
}
