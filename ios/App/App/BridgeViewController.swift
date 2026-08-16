import UIKit
import WebKit
import Capacitor

/// Capacitor 6+ no registra plugins locales del target App solos.
final class BridgeViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        // Sin NativeAudio/AVPlayer: la biblioteca vuelve a HTML5 (calidad PWA).
        // NowPlaying/AVPlayer se dejan fuera a propósito.
    }

    override public func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: instanceConfiguration)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        return config
    }
}
