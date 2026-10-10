import AVFoundation
import MediaPlayer
import UIKit

// The viewer's audio session and lock-screen controls. Videos play on through lock and the
// background (UIBackgroundModes audio). While the current video is muted the session mixes with
// other apps, so music keeps playing; unmuted, it takes over like Safari's video with sound and
// shows on the lock screen and in Control Center, where play/pause, the scrubber (recordings) and
// next/previous (the neighbouring videos) work.
@MainActor
final class ViewerSession {
    struct Commands {
        let play: () -> Void
        let pause: () -> Void
        let toggle: () -> Void
        let step: (Int) -> Void
        let seek: (Double) -> Void
    }

    private var targets: [(MPRemoteCommand, Any)] = []
    private var audible: Bool?
    private var active = false

    func begin(_ commands: Commands) {
        let center = MPRemoteCommandCenter.shared()
        let handlers: [(MPRemoteCommand, (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus)] = [
            (center.playCommand, { _ in commands.play(); return .success }),
            (center.pauseCommand, { _ in commands.pause(); return .success }),
            (center.togglePlayPauseCommand, { _ in commands.toggle(); return .success }),
            (center.nextTrackCommand, { _ in commands.step(1); return .success }),
            (center.previousTrackCommand, { _ in commands.step(-1); return .success }),
            (center.changePlaybackPositionCommand, { event in
                guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
                commands.seek(event.positionTime)
                return .success
            }),
        ]
        for (command, handler) in handlers {
            command.isEnabled = true
            targets.append((command, command.addTarget(handler: handler)))
        }
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
        active = true
    }

    func end() {
        for (command, target) in targets { command.removeTarget(target); command.isEnabled = false }
        targets = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if active { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        active = false
        audible = nil
    }

    func setAudible(_ value: Bool) {
        guard value != audible else { return }
        audible = value
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .moviePlayback, options: value ? [] : [.mixWithOthers])
            try session.setActive(true)
        } catch { print("Audio session:", error.localizedDescription) }
        if !value { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
    }

    func nowPlaying(_ video: ViewerVideo?, _ snapshot: TimelineSnapshot, playing: Bool) {
        guard audible == true, let video else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: video.name,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyIsLiveStream: snapshot.isLive || video.liveStream,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
        ]
        if !snapshot.isLive && !video.liveStream && snapshot.duration.isFinite && snapshot.duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = snapshot.duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = snapshot.currentTime
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPRemoteCommandCenter.shared().changePlaybackPositionCommand.isEnabled = !(snapshot.isLive || video.liveStream)
    }
}
