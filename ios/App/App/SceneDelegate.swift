import UIKit
import Capacitor

/**
 * Un solo WebView: el storyboard ya crea BridgeViewController.
 * Crear otro aquí dejaba dos bridges y el plugin AVPlayer no recibía las llamadas.
 */
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        if let existing = windowScene.windows.first {
            window = existing
        } else {
            let w = UIWindow(windowScene: windowScene)
            w.rootViewController = BridgeViewController()
            w.makeKeyAndVisible()
            window = w
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
