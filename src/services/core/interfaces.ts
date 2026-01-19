export interface IStreamProvider {
    getMasterList(url: string): Promise<string | null>;
    getLiveList(url: string): Promise<{ success: boolean; data: string | null }>;
    getTsSegment(url: string): Promise<Buffer | null>;
}