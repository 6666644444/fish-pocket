import Foundation

/// The App Group the app and its extensions share files through: the share inbox
/// (ShareInbox), the widgets' snapshot and app list (WidgetSnapshotStore, MiniAppCatalog), the
/// call's picture (CallAvatarFile).
///
/// Info.plist's `DshAppGroup` is the group the build asked for. A signing tool may sign with
/// another one: with a free Apple ID, AltStore, SideStore, AltLoad and the like register
/// groups of their own (often the name with the team ID appended), and then the built name
/// opens nothing and the share extension and the widgets see no data. What the signature
/// really allows is in the provisioning profile each app and extension carries
/// (`embedded.mobileprovision`). The group used is the first of these that opens, in an order
/// that is the same in the app and in every extension: the built name, then profile groups
/// that contain it, then the other profile groups by name.
enum AppGroup {
    enum Source: String, Sendable {
        /// Info.plist's `DshAppGroup` opened.
        case infoPlist
        /// A group from the signing profile opened instead.
        case profile
        /// None opened: the signature has no App Group this app can use.
        case none
    }

    struct Resolution: Equatable, Sendable {
        let id: String?
        let source: Source
        let declared: String?
        /// The groups the signing profile lists (empty on a simulator or without a profile).
        let profileGroups: [String]
    }

    /// Resolved once per process: the answer cannot change while it runs.
    static let resolved: Resolution = resolve(
        declared: Bundle.main.object(forInfoDictionaryKey: "DshAppGroup") as? String,
        profileGroups: Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
            .map(profileGroups(in:)) ?? [],
        opens: { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil }
    )

    /// The group to use, or nil when none opens.
    static var id: String? { resolved.id }

    /// The groups to try, in order (see the type's note).
    static func candidates(declared: String?, profileGroups: [String]) -> [String] {
        var list: [String] = []
        func add(_ group: String) { if !group.isEmpty, !list.contains(group) { list.append(group) } }
        let usable = profileGroups.filter { $0.hasPrefix("group.") && !$0.contains("*") }.sorted()
        if let declared { add(declared) }
        if let declared, !declared.isEmpty { for group in usable where group.contains(declared) { add(group) } }
        for group in usable { add(group) }
        return list
    }

    static func resolve(declared: String?, profileGroups: [String], opens: (String) -> Bool) -> Resolution {
        let trimmed = declared?.trimmingCharacters(in: .whitespaces)
        let declared = trimmed?.isEmpty == false ? trimmed : nil
        for group in candidates(declared: declared, profileGroups: profileGroups) where opens(group) {
            return Resolution(id: group, source: group == declared ? .infoPlist : .profile, declared: declared, profileGroups: profileGroups)
        }
        return Resolution(id: nil, source: .none, declared: declared, profileGroups: profileGroups)
    }

    /// The App Groups a provisioning profile allows. The profile is a signed (CMS) envelope
    /// around an XML property list; the list is read straight out of it, unverified: iOS
    /// already checked the signature when it installed the app.
    static func profileGroups(in data: Data) -> [String] {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex) else { return [] }
        let plist = data[start.lowerBound..<end.upperBound]
        guard let root = try? PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any] else { return [] }
        return entitlements["com.apple.security.application-groups"] as? [String] ?? []
    }

    /// One line for 设置 → 学习 → 诊断 and the share extension's error page.
    static var diagnostics: String { describe(resolved) }

    static func describe(_ r: Resolution) -> String {
        let used = r.id ?? String(localized: "无")
        let source = switch r.source {
        case .infoPlist: String(localized: "构建时的名字")
        case .profile: String(localized: "签名描述文件")
        case .none: String(localized: "都打不开")
        }
        let listed = r.profileGroups.isEmpty ? String(localized: "无") : r.profileGroups.joined(separator: ", ")
        let declared = r.declared ?? "—"
        return String(localized: "App Group：\(used)（\(source)）。构建时：\(declared)；签名描述文件里：\(listed)")
    }
}
