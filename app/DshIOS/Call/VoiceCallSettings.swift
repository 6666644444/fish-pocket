import AVFoundation
import Observation
import SwiftUI

/// 设置 → 语音通话: the voice the answers are spoken in, each one heard before picking it, and
/// the Volcengine key with a check that recognition and synthesis 2.0 both work. Also the sheet the
/// call button opens without a key; `onReady` then runs once the check passes.
struct VoiceCallSettingsPage: View {
    var onReady: (() -> Void)?
    @State private var speech = VolcSpeech.shared
    @State private var voice = CallVoice.chosen
    @State private var preview = VoicePreview.shared

    var body: some View {
        List {
            Section {
                Text("在会话和 Bot 的聊天里，输入框空着时点右边的波形按钮，就能像打电话一样和它说话：直接说，说完停一下它就回答；它说话时你一开口，它就停下来听你说。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))

            // Without a key the key comes first: nothing works until it is in.
            if speech.configured {
                voices
                VolcKeySection(purpose: .call, onReady: onReady)
            } else {
                VolcKeySection(purpose: .call, onReady: onReady)
                voices
            }
        }
        .groupedList()
        .scrollDismissesKeyboard(.immediately)
        .navigationTitle("语音通话")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: voice) { CallVoice.chosen = voice }
        .onDisappear { preview.stop() }
    }

    private var voices: some View {
        Section {
            ForEach(CallVoice.all) { item in
                HStack(spacing: 12) {
                    Button {
                        Haptics.select()
                        voice = item
                    } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: item.name).foregroundStyle(Palette.ink)
                                Text(item.kind).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            if voice == item {
                                Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Palette.ink)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button {
                        Haptics.tap()
                        if preview.playing == item.id { preview.stop() } else { preview.play(item) }
                    } label: {
                        Group {
                            if preview.loading == item.id {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: preview.playing == item.id ? "stop.circle.fill" : "play.circle")
                                    .font(.system(size: 22))
                                    .foregroundStyle(Palette.ink)
                            }
                        }
                        .frame(width: 30, height: 30)
                        .hitTarget()
                    }
                    .buttonStyle(.plain)
                    .disabled(!speech.configured || CallCenter.shared.active)
                    .accessibilityLabel(preview.playing == item.id ? Text("停止试听") : Text("试听"))
                }
            }
        } header: {
            Text("声音")
        } footer: {
            Text("回答用这个声音念出来，是豆包语音合成模型 2.0 的音色。试听也按火山引擎的价格计费；通话中改了声音，下一通电话生效。")
        }
        .groupedRow()
    }
}

/// A voice heard before it is picked: a line spoken through the same synthesis a call uses.
@MainActor
@Observable
final class VoicePreview {
    static let shared = VoicePreview()

    /// The voice being heard, and the one whose sound has not come yet.
    private(set) var playing: String?
    private(set) var loading: String?

    @ObservationIgnored private var synthesizer: CallSynthesizer?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var player: AVAudioPlayerNode?
    @ObservationIgnored private var pending = 0
    @ObservationIgnored private var made = false
    @ObservationIgnored private var carry: UInt8?
    private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!

    private init() {}

    func play(_ voice: CallVoice) {
        stop()
        guard let key = VolcSpeech.shared.key, !key.isEmpty else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try AVAudioSession.sharedInstance().setActive(true)
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            player.play()
            self.engine = engine
            self.player = player
        } catch {
            stop()
            return
        }
        playing = voice.id
        loading = voice.id
        made = false
        let synthesizer = CallSynthesizer(key: key, voice: voice.id)
        synthesizer.onEvent = { [weak self] event in Task { @MainActor in self?.handle(event) } }
        self.synthesizer = synthesizer
        let reply = synthesizer.begin()
        synthesizer.say(voice.english
            ? "Hi, this is how I'll sound on your calls. Just talk to me, and pause when you're done."
            : String(localized: "你好，通话时我会用这个声音回答你。想说什么直接说，说完停一下就好。"), reply: reply)
        synthesizer.end(reply: reply)
    }

    func stop() {
        synthesizer?.close()
        synthesizer = nil
        player?.stop()
        engine?.stop()
        if engine != nil, !CallCenter.shared.active {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        engine = nil
        player = nil
        pending = 0
        carry = nil
        playing = nil
        loading = nil
    }

    private func handle(_ event: CallSynthesizer.Event) {
        guard playing != nil else { return }
        switch event {
        case .audio(_, let pcm):
            loading = nil
            schedule(pcm)
        case .finished:
            made = true
            if pending == 0 { stop() }
        case .failed:
            stop()
        default:
            break
        }
    }

    private func schedule(_ pcm: Data) {
        guard let player else { return }
        var bytes = [UInt8](pcm)
        if let carry { bytes.insert(carry, at: 0) }
        carry = bytes.count % 2 == 1 ? bytes.removeLast() : nil
        let frames = bytes.count / 2
        guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return }
        buffer.frameLength = AVAudioFrameCount(frames)
        let samples = buffer.floatChannelData![0]
        for index in 0..<frames {
            let value = Int16(bitPattern: UInt16(bytes[2 * index]) | UInt16(bytes[2 * index + 1]) << 8)
            samples[index] = Float(value) / 32_768
        }
        pending += 1
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.player === player else { return }
                self.pending -= 1
                if self.made && self.pending == 0 { self.stop() }
            }
        }
    }
}
