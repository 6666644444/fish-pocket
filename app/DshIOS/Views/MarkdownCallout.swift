import SwiftUI

/// A callout: a quote whose first line names a kind, as GitHub writes it (`> [!TIP]`, the
/// marker alone on its line) and as Obsidian does (`> [!tip]- 标题`, a title after it, `-` or
/// `+` to fold) — D52. The firefly-typeset plugin asks the model for these; a quote without
/// the marker stays a quote.
struct MarkdownCallout: Hashable {
    enum Kind: String, CaseIterable {
        case note, tip, important, warning, caution
    }

    enum Fold: Hashable {
        /// Always open, as GitHub draws it.
        case fixed
        /// Folds; open until tapped (`+`).
        case open
        /// Folds; shut until tapped (`-`).
        case closed
    }

    var kind: Kind
    /// What follows the marker, or for a kind written in Chinese or unknown, the name itself.
    /// Nil: the kind's own name is shown.
    var title: String?
    var fold: Fold
    /// The rest of the quote, each line's `>` and one space taken off, its indentation kept,
    /// so lists, formulas and quotes inside are drawn as anywhere.
    var body: String

    /// GitHub's five names, Obsidian's, and the Chinese an answer about schoolwork uses.
    private static let names: [String: Kind] = {
        var names: [String: Kind] = [:]
        let groups: [(Kind, [String])] = [
            (.note, ["note", "info", "abstract", "summary", "tldr", "todo", "example", "quote", "cite", "question", "help", "faq",
                     "说明", "备注", "补充", "定义", "笔记", "例题", "例子", "示例", "思路", "分析", "证明", "总结", "小结", "问题"]),
            (.tip, ["tip", "hint", "success", "check", "done",
                    "提示", "技巧", "方法", "妙招", "窍门", "拓展", "延伸"]),
            (.important, ["important", "key",
                          "重点", "要点", "关键", "结论", "核心", "考点", "公式", "定理"]),
            (.warning, ["warning", "attention", "caveat",
                        "注意", "易错", "陷阱", "误区", "提醒", "小心"]),
            (.caution, ["caution", "danger", "error", "failure", "fail", "missing", "bug",
                        "警告", "错误", "禁忌", "危险", "严禁"]),
        ]
        for (kind, words) in groups { for word in words { names[word] = kind } }
        return names
    }()

    /// The callout `lines` (a quote with its `>` taken off) open with, or nil for a plain quote.
    static func parse(_ lines: [String]) -> MarkdownCallout? {
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces), first.hasPrefix("[!"),
              let close = first.firstIndex(of: "]") else { return nil }
        let name = first[first.index(first.startIndex, offsetBy: 2)..<close].trimmingCharacters(in: .whitespaces)
        // `[!` that opens something else (a link's text, a long bracket): not a marker.
        guard !name.isEmpty, name.count <= 16, !name.contains(where: { "[]()!".contains($0) }) else { return nil }
        var rest = first[first.index(after: close)...]
        // `[!text](url)` is a link, not a marker.
        guard rest.first != "(" else { return nil }
        var fold = Fold.fixed
        if rest.first == "-" { fold = .closed; rest = rest.dropFirst() } else if rest.first == "+" { fold = .open; rest = rest.dropFirst() }
        let written = cleanTitle(String(rest))
        let known = names[name.lowercased()]
        // A name in letters is a kind (GitHub's, Obsidian's); one in Chinese or unknown is
        // also the title: `[!易错]` reads 易错, `[!例题]` is a note headed 例题.
        let isKind = known != nil && name.allSatisfy { $0.isASCII && $0.isLetter }
        let title = written.isEmpty ? (isKind ? nil : name) : written
        let body = lines.dropFirst().joined(separator: "\n")
        return MarkdownCallout(kind: known ?? .note, title: title, fold: fold, body: body)
    }

    /// A title is drawn as plain text: emphasis marks a model puts around it are dropped.
    private static func cleanTitle(_ text: String) -> String {
        var title = text.trimmingCharacters(in: .whitespaces)
        for mark in ["**", "__", "`"] { title = title.replacingOccurrences(of: mark, with: "") }
        if title.count >= 2, title.hasPrefix("*") || title.hasPrefix("_"), title.last == title.first { title = String(title.dropFirst().dropLast()) }
        return title.trimmingCharacters(in: .whitespaces)
    }

    /// The kind's name, shown when no title is written.
    var kindName: String {
        switch kind {
        case .note: String(localized: "备注")
        case .tip: String(localized: "提示")
        case .important: String(localized: "重点")
        case .warning: String(localized: "注意")
        case .caution: String(localized: "警告")
        }
    }

    var symbol: String {
        switch kind {
        case .note: "info.circle"
        case .tip: "lightbulb"
        case .important: "exclamationmark.bubble"
        case .warning: "exclamationmark.triangle"
        case .caution: "xmark.octagon"
        }
    }

    /// The system's colours: each has its own shade in dark mode.
    var tint: Color {
        switch kind {
        case .note: .blue
        case .tip: .green
        case .important: .purple
        case .warning: .orange
        case .caution: .red
        }
    }
}

/// A callout in a reply: a tinted card with a bar of its colour, its kind's symbol and its
/// title, then its body drawn as Markdown. A folding one opens and shuts with a tap on the title.
struct CalloutView: View {
    let callout: MarkdownCallout
    /// The body, drawn with the reply's own Markdown settings.
    let content: (String) -> AnyView
    /// Nil until the reader taps; then their choice holds.
    @State private var opened: Bool?
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var open: Bool { opened ?? (callout.fold != .closed) }
    private var hasBody: Bool { !callout.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        VStack(alignment: .leading, spacing: 6) {
            header
            if open && hasBody {
                content(callout.body)
                    .transition(.opacity)
            }
        }
        .padding(.leading, 15)
        .padding(.trailing, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(callout.tint.opacity(colorScheme == .dark ? 0.16 : 0.08))
        .overlay(alignment: .leading) { callout.tint.frame(width: 3) }
        .clipShape(shape)
    }

    @ViewBuilder
    private var header: some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: callout.symbol)
                .font(.subheadline.weight(.semibold))
                .accessibilityHidden(true)
            Text(verbatim: callout.title ?? callout.kindName)
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if callout.fold != .fixed && hasBody {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(callout.tint)
        let spoken = callout.title.map { "\(callout.kindName), \($0)" } ?? callout.kindName
        if callout.fold != .fixed && hasBody {
            Button {
                Haptics.select()
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.2)) { opened = !open }
            } label: {
                label.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(verbatim: spoken))
            .accessibilityHint(open ? Text("收起") : Text("展开"))
        } else {
            label
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: spoken))
                .accessibilityAddTraits(.isHeader)
        }
    }
}
