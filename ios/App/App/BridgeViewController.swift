import UIKit
import WebKit
import Capacitor

/// Capacitor 6+ no registra plugins locales del target App solos.
final class BridgeViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        // Solo AVPlayer: NowPlayingPlugin pisaba MPNowPlayingInfoCenter y rompía la isla
        bridge?.registerPluginInstance(NativeAudioPlugin())
        print("[NativeAudio] plugin registered")
    }

    override public func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        return config
    }
}
