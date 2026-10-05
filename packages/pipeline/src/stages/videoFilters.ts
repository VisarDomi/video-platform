// The scale-then-turn filter chain shared by every production conversion.
// outputWidth/outputHeight are the final size; a turned picture is scaled at
// its portrait size and then turned 90° counterclockwise (head to the left).
export function productionVideoFilters(plan: { outputWidth: number; outputHeight: number; rotate?: boolean }): string[] {
    return plan.rotate
        ? [`zscale=w=${plan.outputHeight}:h=${plan.outputWidth}:filter=lanczos`, "transpose=2", "setsar=1"]
        : [`zscale=w=${plan.outputWidth}:h=${plan.outputHeight}:filter=lanczos`, "setsar=1"];
}
