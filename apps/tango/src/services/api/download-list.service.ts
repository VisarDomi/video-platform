import {CONSTANTS} from "../../core/constants";

export class DownloadListService {
    private accountIds = new Set<string>();
    private baseUrl = CONSTANTS.VIDEO_PLATFORM.BASE_URL;

    public async fetchList(): Promise<void> {
        const res = await fetch(`${this.baseUrl}/api/tango/list`);
        const data = await res.json();
        this.accountIds = new Set(Array.isArray(data) ? data : []);
    }

    public isInList(streamerId: string): boolean {
        return this.accountIds.has(streamerId);
    }

    public async add(streamerId: string): Promise<void> {
        await fetch(`${this.baseUrl}/api/tango/add`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({identifier: streamerId}),
        });
        this.accountIds.add(streamerId);
    }

    public async remove(streamerId: string): Promise<void> {
        await fetch(`${this.baseUrl}/api/tango/remove`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({identifier: streamerId}),
        });
        this.accountIds.delete(streamerId);
    }
}
