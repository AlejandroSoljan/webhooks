import FirebaseCore
import FirebaseMessaging
import SwiftUI
import UIKit
import UserNotifications
import WebKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        FirebaseApp.configure()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }
}

@main
struct MecanApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                MecanWebView()
                    .toolbar {
                        Button("Activar avisos") {
                            Task {
                                if (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) == true {
                                    UIApplication.shared.registerForRemoteNotifications()
                                }
                            }
                        }
                    }
            }
        }
    }
}

struct MecanWebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.configuration.allowsInlineMediaPlayback = true
        if let url = URL(string: "https://asistobot.com.ar/customer-app/MCN") {
            view.load(URLRequest(url: url))
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}

