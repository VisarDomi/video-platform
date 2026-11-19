import type { Simulation, SiteModule } from "../sim.js";
import { Fmp4LiveSite } from "./fmp4-live.js";
import { LadderLiveSite } from "./ladder-live.js";
import { TsLiveSite } from "./ts-live.js";

export function createSites(sim: Simulation, scheme: "http" | "https"): SiteModule[] {
    return [new TsLiveSite(sim, scheme), new LadderLiveSite(sim, scheme), new Fmp4LiveSite(sim, scheme)];
}
