import { CONSTANTS } from "../../core/constants";

export class DownloadListService {
    private aliases = new Set<string>();
    private baseUrl = CONSTANTS.VIDEO_PLATFORM.BASE_URL;

    public async fetchList(): Promise<void> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tango/list`);
            const data = await res.json();
            this.aliases = new Set(Array.isArray(data) ? data : []);
        } catch (e) {
            console.error("DownloadListService: failed to fetch list", e);
        }
    }

    public isInList(alias: string): boolean {
        return this.aliases.has(alias);
    }

    public async add(alias: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tango/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ identifier: alias }),
            });
            if (res.ok) {
                this.aliases.add(alias);
                return true;
            }
        } catch (e) {
            console.error("DownloadListService: failed to add", e);
        }
        return false;
    }

    public async remove(alias: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tango/remove`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ identifier: alias }),
            });
            if (res.ok) {
                this.aliases.delete(alias);
                return true;
            }
        } catch (e) {
            console.error("DownloadListService: failed to remove", e);
        }
        return false;
    }
}
