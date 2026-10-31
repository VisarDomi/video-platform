import UIKit

// The bounded native refresh must commit its replacement before iOS suspends
// the scene. Expiration ends the assertion, never cancels a consumed RT halfway.
@MainActor
final class TangoRenewalLifetime {
    private var identifier=UIBackgroundTaskIdentifier.invalid
    static func begin() -> TangoSession.FinishRenewal {
        let lease=TangoRenewalLifetime()
        lease.identifier=UIApplication.shared.beginBackgroundTask(withName:"Tango session renewal"){
            Task{@MainActor in lease.end()}
        }
        return {await lease.end()}
    }
    private func end(){
        guard identifier != .invalid else{return}
        UIApplication.shared.endBackgroundTask(identifier);identifier = .invalid
    }
}
