import Foundation
import AVFoundation
import MediaPlayer
import UIKit
import Capacitor

/**
 * Reproductor nativo (AVPlayer) + Now Playing.
 * En Capacitor, HTML5/<audio> no publica bien la Dynamic Island; AVPlayer sí.
 */
@objc(NativeAudioPlugin)
public class NativeAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlugin"
    public let jsName = "NativeAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    ]

    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var nowPlayingInfo: [String: Any] = [:]
    private var commandsWired = false
    private var currentFileUrl: String?

    public override func load() {
        super.load()
        activateAudioSession()
        wireRemoteCommandsIfNeeded()
        print("[NativeAudio] plugin loaded")
    }

    deinit {
        removeObservers()
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), !urlString.isEmpty else {
            call.reject("url required")
            return
        }
        DispatchQueue.main.async {
            self.activateAudioSession()
            guard let url = self.resolvePlayUrl(urlString) else {
                call.reject("invalid url")
                return
            }

            self.removeObservers()
            let item = AVPlayerItem(url: url)
            let player = self.player ?? AVPlayer()
            self.player = player
            player.replaceCurrentItem(with: item)
            self.currentFileUrl = url.absoluteString

            var info = self.nowPlayingInfo
            if let title = call.getString("title") { info[MPMediaItemPropertyTitle] = title }
            if let artist = call.getString("artist") { info[MPMediaItemPropertyArtist] = artist }
            if let album = call.getString("album") { info[MPMediaItemPropertyAlbumTitle] = album }
            info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue)
            info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
            info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0

            let position = call.getDouble("position") ?? 0
            if position > 0.25 {
                let t = CMTime(seconds: position, preferredTimescale: 600)
                player.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero)
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
            } else {
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = 0
            }

            let artworkSrc = call.getString("artwork")
            let finish: () -> Void = {
                self.applyNowPlaying(info)
                self.attachObservers(player)
                player.play()
                self.notifyListeners("state", data: ["playing": true])
                call.resolve()
            }

            if let artworkSrc, !artworkSrc.isEmpty {
                Self.loadImage(from: artworkSrc) { image in
                    if let image {
                        info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    }
                    finish()
                }
            } else {
                finish()
            }
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.player?.pause()
            var info = self.nowPlayingInfo
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            if let t = self.player?.currentTime().seconds, t.isFinite {
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, t)
            }
            self.applyNowPlaying(info)
            self.notifyListeners("state", data: ["playing": false])
            call.resolve()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.activateAudioSession()
            self.player?.play()
            var info = self.nowPlayingInfo
            info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
            if let t = self.player?.currentTime().seconds, t.isFinite {
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, t)
            }
            self.applyNowPlaying(info)
            self.notifyListeners("state", data: ["playing": true])
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.removeObservers()
            self.player?.pause()
            self.player?.replaceCurrentItem(with: nil)
            self.currentFileUrl = nil
            self.nowPlayingInfo = [:]
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            self.notifyListeners("state", data: ["playing": false])
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position") else {
            call.reject("position required")
            return
        }
        DispatchQueue.main.async {
            let t = CMTime(seconds: max(0, position), preferredTimescale: 600)
            self.player?.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                guard let self else { return }
                var info = self.nowPlayingInfo
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, position)
                if let d = self.player?.currentItem?.duration.seconds, d.isFinite, d > 0 {
                    info[MPMediaItemPropertyPlaybackDuration] = d
                }
                self.applyNowPlaying(info)
                call.resolve()
            }
        }
    }

    @objc func setMetadata(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var info = self.nowPlayingInfo
            if let title = call.getString("title") { info[MPMediaItemPropertyTitle] = title }
            if let artist = call.getString("artist") { info[MPMediaItemPropertyArtist] = artist }
            if let album = call.getString("album") { info[MPMediaItemPropertyAlbumTitle] = album }
            info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue)

            let artworkSrc = call.getString("artwork") ?? Self.firstArtworkSrc(from: call)
            if let artworkSrc, !artworkSrc.isEmpty {
                Self.loadImage(from: artworkSrc) { image in
                    if let image {
                        info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    }
                    self.applyNowPlaying(info)
                    call.resolve()
                }
                return
            }
            self.applyNowPlaying(info)
            call.resolve()
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let p = self.player
            let pos = p?.currentTime().seconds ?? 0
            let dur = p?.currentItem?.duration.seconds ?? 0
            let playing = (p?.rate ?? 0) > 0.01
            call.resolve([
                "playing": playing,
                "position": pos.isFinite ? pos : 0,
                "duration": dur.isFinite && dur > 0 ? dur : 0,
                "url": self.currentFileUrl as Any,
            ])
        }
    }

    private func resolvePlayUrl(_ raw: String) -> URL? {
        var url: URL?
        if raw.hasPrefix("file:") {
            url = URL(string: raw)
        } else if let decoded = raw.removingPercentEncoding {
            if decoded.hasPrefix("file:") {
                url = URL(string: decoded)
            } else if let range = decoded.range(of: "/_capacitor_file_") {
                let path = String(decoded[range.upperBound...])
                url = URL(fileURLWithPath: path)
            }
        } else if raw.hasPrefix("/") {
            url = URL(fileURLWithPath: raw)
        } else {
            url = URL(string: raw)
        }

        guard let source = url else { return nil }

        // .bin con MP3 dentro: AVPlayer a veces falla sin extensión; hard-link a .mp3
        if source.isFileURL && source.pathExtension.lowercased() == "bin" {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("myvibe-\(source.lastPathComponent).mp3")
            try? FileManager.default.removeItem(at: tmp)
            do {
                try FileManager.default.linkItem(at: source, to: tmp)
                return tmp
            } catch {
                do {
                    try FileManager.default.copyItem(at: source, to: tmp)
                    return tmp
                } catch {
                    return source
                }
            }
        }
        return source
    }

    private func attachObservers(_ player: AVPlayer) {
        removeObservers()
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] time in
            guard let self else { return }
            let pos = time.seconds
            let dur = player.currentItem?.duration.seconds ?? 0
            if pos.isFinite {
                var info = self.nowPlayingInfo
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, pos)
                if dur.isFinite && dur > 0 {
                    info[MPMediaItemPropertyPlaybackDuration] = dur
                }
                info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
                self.nowPlayingInfo = info
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                self.notifyListeners("time", data: [
                    "position": max(0, pos),
                    "duration": dur.isFinite && dur > 0 ? dur : 0,
                    "playing": player.rate > 0.01,
                ])
            }
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: player.currentItem,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            var info = self.nowPlayingInfo
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            self.applyNowPlaying(info)
            self.notifyListeners("ended", data: [:])
            self.notifyListeners("state", data: ["playing": false])
        }
    }

    private func removeObservers() {
        if let obs = timeObserver, let player {
            player.removeTimeObserver(obs)
        }
        timeObserver = nil
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        endObserver = nil
    }

    private func applyNowPlaying(_ info: [String: Any]) {
        nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        UIApplication.shared.beginReceivingRemoteControlEvents()
        wireRemoteCommandsIfNeeded()
    }

    private func activateAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            print("[NativeAudio] session error: \(error)")
        }
    }

    private func wireRemoteCommandsIfNeeded() {
        guard !commandsWired else { return }
        commandsWired = true
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            self?.player?.play()
            var info = self?.nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
            self?.applyNowPlaying(info)
            self?.notifyListeners("remote", data: ["action": "play"])
            self?.notifyListeners("state", data: ["playing": true])
            return .success
        }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            self?.player?.pause()
            var info = self?.nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
            if let t = self?.player?.currentTime().seconds, t.isFinite {
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, t)
            }
            self?.applyNowPlaying(info)
            self?.notifyListeners("remote", data: ["action": "pause"])
            self?.notifyListeners("state", data: ["playing": false])
            return .success
        }
        center.nextTrackCommand.isEnabled = true
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remote", data: ["action": "nexttrack"])
            return .success
        }
        center.previousTrackCommand.isEnabled = true
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remote", data: ["action": "previoustrack"])
            return .success
        }
        center.changePlaybackPositionCommand.isEnabled = true
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self,
                  let e = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            let t = CMTime(seconds: e.positionTime, preferredTimescale: 600)
            self.player?.seek(to: t)
            var info = self.nowPlayingInfo
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = e.positionTime
            self.applyNowPlaying(info)
            self.notifyListeners("remote", data: [
                "action": "seekto",
                "seekTime": e.positionTime,
            ])
            return .success
        }
        center.skipForwardCommand.isEnabled = false
        center.skipBackwardCommand.isEnabled = false
    }

    private static func firstArtworkSrc(from call: CAPPluginCall) -> String? {
        guard let artwork = call.getArray("artwork") as? [[String: Any]],
              let first = artwork.first,
              let src = first["src"] as? String
        else { return nil }
        return src
    }

    private static func loadImage(from src: String, completion: @escaping (UIImage?) -> Void) {
        if src.hasPrefix("data:"), let comma = src.firstIndex(of: ",") {
            let meta = String(src[..<comma])
            let payload = String(src[src.index(after: comma)...])
            let raw: Data?
            if meta.contains(";base64") {
                raw = Data(base64Encoded: payload, options: [.ignoreUnknownCharacters])
            } else {
                raw = payload.removingPercentEncoding?.data(using: .utf8)
            }
            completion(raw.flatMap { UIImage(data: $0) })
            return
        }
        guard let url = URL(string: src) else {
            completion(nil)
            return
        }
        if url.isFileURL {
            completion(UIImage(contentsOfFile: url.path))
            return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let image = data.flatMap { UIImage(data: $0) }
            DispatchQueue.main.async { completion(image) }
        }.resume()
    }
}
