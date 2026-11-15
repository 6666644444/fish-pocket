import Foundation

/// The apps 我的应用 starts with (MiniAppExamples in the bundle, one folder each): copied into
/// `~/apps` once, so they are the user's like any other. One the user deletes stays deleted, and
/// one added in a later version arrives with it.
enum MiniAppExamples {
    private static let offeredKey = "dsh.miniApps.examplesOffered"
    @MainActor private static var done = false

    @MainActor
    static func install() {
        guard !done else { return }
        done = true
        guard let source = Bundle.main.url(forResource: "MiniAppExamples", withExtension: nil) else { return }
        let files = FileManager.default
        var offered = Set(UserDefaults.standard.stringArray(forKey: offeredKey) ?? [])
        let ids = ((try? files.contentsOfDirectory(atPath: source.path)) ?? []).filter(MiniApp.validId).sorted()
        guard ids.contains(where: { !offered.contains($0) }) else { return }
        try? files.createDirectory(at: MiniAppStore.root, withIntermediateDirectories: true)
        for id in ids where !offered.contains(id) {
            let target = MiniAppStore.root.appending(path: id, directoryHint: .isDirectory)
            // An app of the user's own by that name stays as it is.
            if !files.fileExists(atPath: target.path) {
                try? files.copyItem(at: source.appending(path: id, directoryHint: .isDirectory), to: target)
            }
            offered.insert(id)
        }
        UserDefaults.standard.set(offered.sorted(), forKey: offeredKey)
    }
}
