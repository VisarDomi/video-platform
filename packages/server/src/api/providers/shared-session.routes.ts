import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { SharedSessionSnapshot } from "sdk";
import { phoneKey, phoneKeyPath } from "./phone-session.routes.js";

// Read-only handoff of a single-session destination's shared cookies to a companion device.
// Served as GET /api/<destination>/shared-session, guarded by X-Phone-Key
// (<destination>-phone-key in the shared state folder). Never initiates a login or logs values.
export interface SharedSessionDependencies {
    key(): string | null;
    read(): Promise<SharedSessionSnapshot | null>;
}

export function sharedSessionDependencies(
    destinationId: string,
    read: () => Promise<SharedSessionSnapshot | null>,
): SharedSessionDependencies {
    const keyFile = phoneKeyPath({ id: destinationId });
    return {
        key: () => { try { return phoneKey(keyFile); } catch { return null; } },
        read,
    };
}

export function createSharedSessionRoutes(destinationId: string, dependencies: SharedSessionDependencies): Router {
    const route = `/api/${destinationId}/shared-session`;
    const router = Router();
    const authorized = (request: Request): boolean => {
        const key = dependencies.key(), given = request.get("X-Phone-Key") ?? "";
        const expected = Buffer.from(key ?? ""), supplied = Buffer.from(given);
        return !!key && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    };
    router.get(route, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (!authorized(request)) return void response.status(401).json({ error: "Not allowed" });
        try {
            const session = await dependencies.read();
            if (!session || session.cookies.length === 0) {
                return void response.status(503).json({ error: "No shared session is stored on the PC" });
            }
            response.json(session);
        } catch (error) {
            response.status(502).json({ error: error instanceof Error ? error.message : "Could not read the shared session" });
        }
    });
    return router;
}
