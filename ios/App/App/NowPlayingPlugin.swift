import Foundation
import MediaPlayer
import UIKit
import AVFoundation
import Capacitor

/**
 * Publica metadatos en MPNowPlayingInfoCenter.
 * WKWebView pisa Now Playing al reproducir HTML5; por eso reafirmamos
 * la ficha en un timer mientras suena (Safari PWA no tiene este problema).
 */
@objc(NowPlayingPlugin)
public class NowPlayingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NowPlayingPlugin"
    public let jsName = "NowPlaying"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPositionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise),
    ]

    private var nowPlayingInfo: [String: Any] = [:]
    private var commandsWired = false
    private var reassertTimer: Timer?
    private var isPlaying = false

    public override func load() {
        super.load()
        wireRemoteCommandsIfNeeded()
        print("[NowPlaying] plugin loaded")
    }

    @objc func setMetadata(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.activateAudioSession()
            var info = self.nowPlayingInfo

            if let title = call.getString("title") {
                info[MPMediaItemPropertyTitle] = title
            }
            if let artist = call.getString("artist") {
                info[MPMediaItemPropertyArtist] = artist
            }
            if let album = call.getString("album") {
                info[MPMediaItemPropertyAlbumTitle] = album
            }
            info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue)
            if info[MPNowPlayingInfoPropertyDefaultPlaybackRate] == nil {
                info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
            }

            let artworkSrc = Self.firstArtworkSrc(from: call)
            if let artworkSrc, !artworkSrc.isEmpty {
                Self.loadImage(from: artworkSrc) { image in
                    if let image {
                        info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                    }
                    self.apply(info)
                    call.resolve()
                }
                return
            }

            self.apply(info)
            call.resolve()
        }
    }

    @objc func setPlaybackState(_ call: CAPPluginCall) {
        guard let state = call.getString("playbackState") else {
            call.reject("playbackState required")
            return
        }
        DispatchQueue.main.async {
            self.activateAudioSession()
            var info = self.nowPlayingInfo
            switch state {
            case "playing":
                self.isPlaying = true
                info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
                self.startReassertTimer()
            case "paused":
                self.isPlaying = false
                info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                self.stopReassertTimer()
            default:
                self.isPlaying = false
                info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
                self.stopReassertTimer()
            }
            info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
            info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue)
            self.apply(info)
            call.resolve()
        }
    }

    @objc func setPositionState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var info = self.nowPlayingInfo
            if let duration = call.getDouble("duration") {
                info[MPMediaItemPropertyPlaybackDuration] = max(0, duration)
            }
            if let position = call.getDouble("position") {
                let duration = (info[MPMediaItemPropertyPlaybackDuration] as? Double)
                    ?? call.getDouble("duration")
                    ?? 0
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, min(position, max(0, duration)))
            }
            if let rate = call.getDouble("playbackRate") {
                info[MPNowPlayingInfoPropertyPlaybackRate] = rate
                self.isPlaying = rate > 0.01
                if self.isPlaying {
                    self.startReassertTimer()
                }
            }
            info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = 1.0
            info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue)
            self.apply(info)
            call.resolve()
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.isPlaying = false
            self.stopReassertTimer()
            self.nowPlayingInfo = [:]
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            call.resolve()
        }
    }

    private func apply(_ info: [String: Any]) {
        nowPlayingInfo = info
        // Forzar escritura completa: WKWebView a veces deja un diccionario vacío
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        UIApplication.shared.beginReceivingRemoteControlEvents()
        wireRemoteCommandsIfNeeded()
    }

    private func startReassertTimer() {
        guard reassertTimer == nil else { return }
        // WKWebView pisa Now Playing tras cada play(); reescribir ~2×/s
        let timer = Timer(timeInterval: 0.45, repeats: true) { [weak self] _ in
            guard let self, self.isPlaying, !self.nowPlayingInfo.isEmpty else { return }
            var info = self.nowPlayingInfo
            // Avanzar posición estimada entre updates JS
            if let elapsed = info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double,
               let rate = info[MPNowPlayingInfoPropertyPlaybackRate] as? Double,
               rate > 0 {
                info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed + 0.45 * rate
                self.nowPlayingInfo = info
            }
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }
        RunLoop.main.add(timer, forMode: .common)
        reassertTimer = timer
    }

    private func stopReassertTimer() {
        reassertTimer?.invalidate()
        reassertTimer = nil
    }

    private func activateAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            print("[NowPlaying] AVAudioSession error: \(error)")
        }
    }

    private func wireRemoteCommandsIfNeeded() {
        guard !commandsWired else { return }
        commandsWired = true
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remote", data: ["action": "play"])
            return .success
        }
        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            self?.notifyListeners("remote", data: ["action": "pause"])
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
            guard let e = event as? MPChangePlaybackPositionCommandEvent else {
                return .commandFailed
            }
            self?.notifyListeners("remote", data: [
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
            } else if let decoded = payload.removingPercentEncoding?.data(using: .utf8) {
                raw = decoded
            } else {
                raw = nil
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
            DispatchQueue.main.async {
                completion(image)
            }
        }.resume()
    }
}
