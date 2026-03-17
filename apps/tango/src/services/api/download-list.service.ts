import { CONSTANTS } from "../../core/constants";

export class DownloadListService {
    private accountIds = new Set<string>();
    private baseUrl = CONSTANTS.VIDEO_PLATFORM.BASE_URL;

    public async fetchList(): Promise<void> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tango/list`);
            const data = await res.json();
            this.accountIds = new Set(Array.isArray(data) ? data : []);
        } catch (e) {
            console.error("DownloadListService: failed to fetch list", e);
        }
    }

    public isInList(streamerId: string): boolean {
        return this.accountIds.has(streamerId);
    }

    public async add(streamerId: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tango/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ identifier: streamerId }),
            });
            if (res.ok) {
                this.accountIds.add(streamerId);
                return true;
            }
        } catch (e) {
            console.error("DownloadListService: failed to add", e);
        }
        return false;
    }

    public async remove(streamerId: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tango/remove`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ identifier: streamerId }),
            });
            if (res.ok) {
                this.accountIds.delete(streamerId);
                return true;
            }
        } catch (e) {
            console.error("DownloadListService: failed to remove", e);
        }
        return false;
    }
}
