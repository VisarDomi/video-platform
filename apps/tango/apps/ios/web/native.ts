export async function native(command: string, args: unknown = {}): Promise<any> {
    return JSON.parse(await (window as any).webkit.messageHandlers.viewer.postMessage({command, args}));
}
