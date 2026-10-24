import Foundation

// Bug 1: Strong delegate reference (should be weak)
protocol NotificationServiceDelegate: AnyObject {
    func didReceiveNotification(_ notification: String)
}

class NotificationService {
    // This should be `weak var delegate` to avoid a retain cycle
    var delegate: NotificationServiceDelegate?

    private var isListening = false

    func startListening() {
        isListening = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleNotification(_:)),
            name: NSNotification.Name("AppNotification"),
            object: nil
        )
    }

    @objc private func handleNotification(_ notification: Notification) {
        if let message = notification.userInfo?["message"] as? String {
            delegate?.didReceiveNotification(message)
        }
    }

    // Bug 2: No deinit removing the observer — will leak and receive
    // notifications after the object should have been deallocated.
    // Missing:
    // deinit {
    //     NotificationCenter.default.removeObserver(self)
    // }
}
