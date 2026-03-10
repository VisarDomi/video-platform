export interface AliasReport {
	alias: string;
	downloadedGB: number;
	downloadedCount: number;
	editedGB: number;
	editedCount: number;
	editPercent: number;
}

export interface MonthReport {
	month: string;
	generatedAt: string;
	totalDownloadedGB: number;
	totalEditedGB: number;
	totalDownloadedCount: number;
	totalEditedCount: number;
	overallEditPercent: number;
	aliases: AliasReport[];
	fromSnapshot?: boolean;
}
