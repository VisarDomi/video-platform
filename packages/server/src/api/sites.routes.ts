import { Router } from "express";

// The website's sites: the capture sites of the sites file, in its order (the first is
// the default page), with each plug-in's display name and whether it has a download list.
export interface PublicSite {
    readonly id: string;
    readonly label: string;
    readonly list: boolean;
}

export function createSitesRoutes(sites: readonly PublicSite[]): Router {
    const router = Router();
    const body = JSON.stringify({ sites });
    router.get("/api/sites", (_req, res) => {
        res.set("Cache-Control", "no-cache");
        res.type("application/json").send(body);
    });
    return router;
}
