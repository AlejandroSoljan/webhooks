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
                MecanHome()
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

private struct MecanHome: View {
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        MecanWebView { failed = $0 }
            .id(attempt)
            .overlay {
                if failed {
                    ContentUnavailableView {
                        Label("No pudimos abrir Mecan", systemImage: "wifi.exclamationmark")
                    } actions: {
                        Button("Reintentar") {
                            failed = false
                            attempt += 1
                        }
                    }
                    .background(.background)
                }
            }
    }
}

private struct MecanWebView: UIViewRepresentable {
    var loadFailed: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(loadFailed: loadFailed)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.load(URLRequest(url: URL(string: "https://asisto.com.ar/customer-app/MCN")!, timeoutInterval: 25))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let loadFailed: (Bool) -> Void

        init(loadFailed: @escaping (Bool) -> Void) {
            self.loadFailed = loadFailed
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            report(error)
        }

        private func report(_ error: Error) {
            let failure = error as NSError
            guard failure.domain != NSURLErrorDomain || failure.code != NSURLErrorCancelled else { return }
            NSLog("Mecan web navigation failed: %@ %ld", failure.domain, failure.code)
            loadFailed(true)
        }
    }
}

