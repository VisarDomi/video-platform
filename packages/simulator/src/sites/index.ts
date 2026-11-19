import type { Simulation, SiteModule } from "../sim.js";
import { ApiHostSite } from "./api-host.js";
import { FileHostSite } from "./file-host.js";
import { Fmp4LiveSite } from "./fmp4-live.js";
import { FormHostSite } from "./form-host.js";
import { LadderLiveSite } from "./ladder-live.js";
import { TsLiveSite } from "./ts-live.js";

export function createSites(sim: Simulation, scheme: "http" | "https"): SiteModule[] {
    return [
        new TsLiveSite(sim, scheme), new LadderLiveSite(sim, scheme), new Fmp4LiveSite(sim, scheme),
        new FileHostSite(sim, scheme), new FormHostSite(sim, scheme), new ApiHostSite(sim, scheme),
    ];
}
