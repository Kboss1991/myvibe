import UIKit
import WebKit
import Capacitor

/// Capacitor 6+ no registra plugins locales del target App solos.
final class BridgeViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        // NowPlaying: metadatos + remotes (like/bookmark) para CarPlay/bloqueo.
        // Sin NativeAudio/AVPlayer: la biblioteca sigue en HTML5.
        bridge?.registerPluginInstance(NowPlayingPlugin())
    }

    override public func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        return config
    }
}
