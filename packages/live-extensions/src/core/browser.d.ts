// The part of Safari's web extension API these extensions use.
declare const browser: {
    runtime: {
        sendMessage(message: unknown): Promise<unknown>;
        onMessage: { addListener(listener: (message: unknown) => Promise<unknown> | undefined): void };
    };
};
// The provider's download-list API path, fixed per extension at build time.
declare const __API_PATH__: string;
