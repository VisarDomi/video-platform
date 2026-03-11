export const PROVIDER_IDS = ['tango', 'fc2', 'sc'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderConfig {
	readonly id: ProviderId;
	readonly downloaderDir: string;
	readonly editedDir: string;
	readonly snapshotsDir: string;
}

export interface AliasReport {
	readonly alias: string;
	readonly downloadedGB: number;
	readonly downloadedCount: number;
	readonly editedGB: number;
	readonly editedCount: number;
	readonly editPercent: number;
}

export interface MonthReport {
	readonly provider: ProviderId;
	readonly month: string;
	readonly generatedAt: string;
	readonly totalDownloadedGB: number;
	readonly totalEditedGB: number;
	readonly totalDownloadedCount: number;
	readonly totalEditedCount: number;
	readonly overallEditPercent: number;
	readonly aliases: readonly AliasReport[];
	readonly fromSnapshot?: boolean;
}
