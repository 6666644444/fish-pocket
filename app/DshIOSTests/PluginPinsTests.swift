import XCTest
@testable import DshIOS

/// Models/PluginPins.swift: the engine's refusal (engine/plugins/ios-host/pins.mjs `pinRefusal`)
/// turned into a sentence. The engine's English wording names Fish Pocket; renaming the app to
/// Firefly must not change what is matched (it did once, in a blanket rename).
final class PluginPinsTests: XCTestCase {
    func testTheEngineRefusalIsRecognised() {
        let text = PluginPins.refusal("ds-bot is pinned to 0.3.8 in Fish Pocket; 0.4.0 cannot be installed.")
        XCTAssertNotNil(text)
        XCTAssertTrue(text?.contains("0.3.8") == true)
        XCTAssertTrue(text?.contains("0.4.0") == true)
    }

    func testOtherTextIsLeftAlone() {
        XCTAssertNil(PluginPins.refusal("network error"))
        XCTAssertNil(PluginPins.refusal(nil))
    }
}
