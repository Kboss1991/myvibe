import CarPlay
import UIKit

/**
 * Escena CarPlay: al pulsar MyVibe en el coche se abre Now Playing.
 * El icono en la parrilla solo aparece si Apple ha concedido
 * com.apple.developer.carplay-audio al Team ID.
 */
class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    var interfaceController: CPInterfaceController?

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        interfaceController.setRootTemplate(
            CPNowPlayingTemplate.shared,
            animated: false,
            completion: nil
        )
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        self.interfaceController = nil
    }
}
