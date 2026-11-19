import type { Logger, PluginStore, Target } from "sdk";

const KEY = "names";

// Every name each channel has been seen with, current first, kept in the core's
// crash-safe store. Channels rename themselves; a recording folder carries the name the
// channel had when its capture started, so after a restart the folder is matched to its
// channel by this history.
export class NameHistory {
    private names = new Map<string, string[]>();

    constructor(private readonly store: PluginStore, private readonly log: Logger) {}

    public async load(): Promise<void> {
        const saved = await this.store.read<Record<string, string[]>>(KEY);
        this.names = new Map(Object.entries(saved ?? {}).filter(([, list]) => Array.isArray(list)));
    }

    public current(id: string): string | null {
        return this.names.get(id)?.[0] ?? null;
    }

    // Records the name the site reports for a channel; durable when it resolves.
    public async observe(target: Target, name: string): Promise<void> {
        const known = this.names.get(target.id) ?? [];
        if (known[0] === name) return;
        const previous = known[0] ?? target.label;
        if (previous !== name) this.log.info(`Channel ${target.id} is now named ${name} (was ${previous})`);
        this.names.set(target.id, [name, ...[...known, target.label].filter((old) => old !== name)]
            .filter((value, index, all) => all.indexOf(value) === index));
        await this.store.write(KEY, Object.fromEntries(this.names));
    }

    // The listed channel that has had this name.
    public targetFor(name: string, targets: readonly Target[]): string | null {
        return targets.find((target) => target.id !== "" && this.names.get(target.id)?.includes(name))?.id ?? null;
    }
}
