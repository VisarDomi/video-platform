import Foundation

// A stopped inline host is never reused. Keep its C decoder and byte-reader
// lifetimes together while their lock/drain work finishes away from gestures.
enum InlineDecoderRetirement {
    private static let queue = DispatchQueue(label: "com.visar.video.decoder-retirement", qos: .userInitiated)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var pending = 0

    static var count: Int {
        lock.lock(); defer { lock.unlock() }
        return pending
    }

    static func retire(video: any VideoDecodingPipeline, audio: (any SoftwareAudioProducing)?,
                       demuxer: Demuxer?, renderer: SampleBufferRenderer, output: AudioOutput?,
                       videoRemoval: Task<Void, Never>?) {
        lock.lock(); pending += 1; lock.unlock()
        Task.detached(priority: .userInitiated) {
            // Keep the output and layer alive across their asynchronous removal.
            // The last resource release then belongs to the retirement worker.
            await videoRemoval?.value
            queue.async {
                output?.stop()
                audio?.close()
                video.close()
                demuxer?.close()
                // A frame admitted before stop may have finished during removal.
                renderer.flush()
                withExtendedLifetime(output) {}
                lock.lock(); pending -= 1; lock.unlock()
            }
        }
    }
}
