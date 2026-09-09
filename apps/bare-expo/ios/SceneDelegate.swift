internal import Expo
import SwiftUI

@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
#if DEBUG
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    // Isolated native experiment. Normal launches still start the Expo app.
    if #available(iOS 17.0, *),
      ProcessInfo.processInfo.arguments.contains("--swiftui-list-anchor-probe"),
      let windowScene = scene as? UIWindowScene {
      let window = UIWindow(windowScene: windowScene)
      window.rootViewController = UIHostingController(rootView: ListAnchorProbe())
      self.window = window
      (UIApplication.shared.delegate as? AppDelegate)?.window = window
      window.makeKeyAndVisible()
      return
    }
    super.scene(scene, willConnectTo: session, options: connectionOptions)
  }
#endif
}
