export const PROVIDER_IDS = ['tango', 'fc2', 'sc'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_META: Record<ProviderId, { label: string; accent: string }> = {
	tango: { label: 'Tango', accent: '#f97316' },
	fc2: { label: 'FC2', accent: '#3b82f6' },
	sc: { label: 'SC', accent: '#a855f7' }
};

export interface AliasReport {
	alias: string;
	downloadedGB: number;
	downloadedCount: number;
	editedGB: number;
	editedCount: number;
	editPercent: number;
}

export interface MonthReport {
	provider: ProviderId;
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
