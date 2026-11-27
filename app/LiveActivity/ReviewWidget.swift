import SwiftUI
import WidgetKit

/// 错题复习 on the home screen and the lock screen (D53): how many mistake-book questions are up for
/// review today, counted from the review dates the app last wrote (Shared/ReviewCatalog.swift), so
/// the number goes up at midnight on its own. A tap opens 今日复习.
struct ReviewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: ReviewCatalog.widgetKind, provider: ReviewProvider()) { entry in
            ReviewWidgetView(entry: entry)
        }
        .configurationDisplayName("错题复习")
        .description("今天要复习几道错题，点一下开始复习。")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular])
    }
}

struct ReviewEntry: TimelineEntry {
    let date: Date
    let snapshot: ReviewSnapshot

    var due: Int { snapshot.due(at: date) }
}

struct ReviewProvider: TimelineProvider {
    func placeholder(in context: Context) -> ReviewEntry {
        ReviewEntry(date: .now, snapshot: ReviewSnapshot(dueTimes: [0, 0, 0], prompts: [], writtenAt: .now))
    }

    func getSnapshot(in context: Context, completion: @escaping (ReviewEntry) -> Void) {
        completion(ReviewEntry(date: .now, snapshot: ReviewCatalog.read()))
    }

    /// Now, and each moment more questions come due (midnights, as the engine sets them).
    func getTimeline(in context: Context, completion: @escaping (Timeline<ReviewEntry>) -> Void) {
        let snapshot = ReviewCatalog.read()
        var entries = [ReviewEntry(date: .now, snapshot: snapshot)]
        var from = Date.now
        for _ in 0..<12 {
            guard let next = snapshot.nextChange(after: from) else { break }
            entries.append(ReviewEntry(date: next, snapshot: snapshot))
            from = next
        }
        completion(Timeline(entries: entries, policy: .never))
    }
}

private struct ReviewWidgetView: View {
    let entry: ReviewEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Group {
            switch family {
            case .accessoryCircular: circular
            case .accessoryRectangular: rectangular
            case .systemMedium: medium
            default: small
            }
        }
        .containerBackground(for: .widget) {
            if family == .systemSmall || family == .systemMedium { WidgetPalette.background } else { Color.clear }
        }
        .widgetURL(DshLink.review.url)
    }

    /// What the count says under it.
    private var line: String {
        if entry.snapshot.unset { return String(localized: "打开 Firefly 的学习页后显示") }
        if entry.due > 0 { return String(localized: "道错题今天要复习") }
        return entry.snapshot.dueTimes.isEmpty ? String(localized: "错题本是空的") : String(localized: "今天没有要复习的题")
    }

    private var title: some View {
        Label("错题复习", systemImage: "calendar.badge.clock")
            .font(.caption.weight(.semibold))
            .foregroundStyle(WidgetPalette.secondary)
            .lineLimit(1)
    }

    private var count: some View {
        Text(verbatim: "\(entry.due)")
            .font(.system(size: 44, weight: .bold, design: .rounded))
            .foregroundStyle(entry.due > 0 ? WidgetPalette.waiting : WidgetPalette.ink)
            .contentTransition(.numericText())
    }

    private var small: some View {
        VStack(alignment: .leading, spacing: 2) {
            title
            Spacer(minLength: 0)
            count
            Text(line).font(.caption).foregroundStyle(WidgetPalette.secondary).lineLimit(2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var medium: some View {
        HStack(alignment: .top, spacing: 14) {
            small.frame(width: 118)
            VStack(alignment: .leading, spacing: 6) {
                if entry.due > 0 && !entry.snapshot.prompts.isEmpty {
                    ForEach(Array(entry.snapshot.prompts.prefix(3).enumerated()), id: \.offset) { _, prompt in
                        Text(verbatim: prompt)
                            .font(.caption)
                            .foregroundStyle(WidgetPalette.ink)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(WidgetPalette.field, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                } else {
                    Spacer(minLength: 0)
                    Text("答错的题第二天出现在这里，之后隔 3 天、7 天各复习一次。")
                        .font(.caption).foregroundStyle(WidgetPalette.secondary).lineLimit(4)
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                Image(systemName: "calendar.badge.clock").font(.caption2)
                Text(verbatim: "\(entry.due)").font(.title3.weight(.bold)).minimumScaleFactor(0.6)
            }
        }
        .accessibilityLabel(Text("错题复习"))
        .accessibilityValue(Text("今天 \(entry.due) 题"))
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label("错题复习", systemImage: "calendar.badge.clock").font(.caption.weight(.semibold))
            Text("今天 \(entry.due) 题").font(.headline)
            if let prompt = entry.snapshot.prompts.first, entry.due > 0 {
                Text(verbatim: prompt).font(.caption2).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
