import UIKit
import Capacitor

/// Capacitor 6+ no registra plugins locales del target App solos.
final class BridgeViewController: CAPBridgeViewController {
    override public func capacitorDidLoad() {
        bridge?.registerPluginInstance(NowPlayingPlugin())
    }
}
