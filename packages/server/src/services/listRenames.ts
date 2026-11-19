import type { Catalog, Target } from "sdk";

// Applies new names to a download list: every line whose target has another current name
// is written again by the site's catalog; every other line keeps its bytes. Returns the
// new content, or null when nothing changed. `renamed` hears of each change.
export function renameListedTargets(
    content: string,
    catalog: Pick<Catalog, "parseTargetLine" | "formatTargetLine">,
    currentName: (id: string) => string | undefined,
    renamed: (target: Target, current: string) => void,
): string | null {
    const lines = content.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
        const target = catalog.parseTargetLine(lines[i]);
        if (!target?.id) continue;

        const current = currentName(target.id);
        if (!current || current === target.label) continue;

        lines[i] = catalog.formatTargetLine({ id: target.id, label: current });
        renamed(target, current);
        changed = true;
    }

    return changed ? lines.join("\n") : null;
}
