import Foundation

class ProfileViewModel {
    var onUpdate: (() -> Void)?

    func startObserving() {
        onUpdate = {
            self.refresh()
        }
    }

    func refresh() { }
}
