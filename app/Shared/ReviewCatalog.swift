import Foundation

/// Today's mistake-book review as the 错题复习 widget sees it (D53). The questions live in the
/// engine's learning library, which the widget extension cannot reach, so the app writes this into
/// the App Group each time it reads the review plan (the learning page, the review, coming to the
/// front). The widget counts from `dueTimes` itself, so the number goes up at midnight without the app.
struct ReviewSnapshot: Codable, Equatable, Sendable {
    /// When each question in the mistake book is next up for review, in ms since 1970, soonest first.
    var dueTimes: [Double]
    /// The first questions due when it was written, a few words each, for the larger widget.
    var prompts: [String]
    var writtenAt: Date

    static let empty = ReviewSnapshot(dueTimes: [], prompts: [], writtenAt: .distantPast)

    /// Questions up for review at `date`.
    func due(at date: Date) -> Int {
        let ms = date.timeIntervalSince1970 * 1000
        return dueTimes.filter { $0 <= ms }.count
    }

    /// The next moment after `date` when more come due, for the widget's timeline.
    func nextChange(after date: Date) -> Date? {
        let ms = date.timeIntervalSince1970 * 1000
        return dueTimes.first { $0 > ms }.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    /// The app has never written one.
    var unset: Bool { writtenAt == .distantPast }
}

enum ReviewCatalog {
    static let widgetKind = "FireflyReview"

    private static var fileURL: URL? {
        guard let groupId = AppGroup.id,
              let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId) else { return nil }
        return container.appending(path: "learning-review.json")
    }

    static func read() -> ReviewSnapshot {
        guard let url = fileURL, let data = try? Data(contentsOf: url) else { return .empty }
        return (try? JSONDecoder().decode(ReviewSnapshot.self, from: data)) ?? .empty
    }

    /// Whether anything but the time of writing changed (the widget is reloaded only then).
    @discardableResult
    static func write(_ snapshot: ReviewSnapshot) -> Bool {
        let old = read()
        guard old.dueTimes != snapshot.dueTimes || old.prompts != snapshot.prompts || old.unset,
              let url = fileURL, let data = try? JSONEncoder().encode(snapshot) else { return false }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return true
    }
}
