import { IAuthProvider } from "./interfaces.js";
import { TangoAuthProvider } from "./tango/index.js";

const providers: Record<string, () => IAuthProvider> = {
    tango: () => new TangoAuthProvider(),
};

export function getProvider(name: string): IAuthProvider {
    const factory = providers[name];
    if (!factory) {
        throw new Error(`Unknown auth provider: "${name}". Available: ${Object.keys(providers).join(", ")}`);
    }
    return factory();
}
