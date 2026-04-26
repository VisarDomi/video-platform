import { DEFAULT_PROVIDER } from '../constants.js';
import { STORAGE_KEYS } from '../constants.js';
import { filterByAliases } from '../utils/filter.js';
import {
	buildAliasFilterGroups,
	expandSelectedAliases,
	type AliasFilterGroup
} from '../utils/filterGroups.js';
import type { Video, VideoType } from '../types.js';

class VideoListStore {
	videos = $state<Video[]>([]);
	isLoading = $state(true);
	selectedProvider = $state<string>(DEFAULT_PROVIDER);
	selectedAliases = $state<Set<string>>(new Set());
	identityAliasGroups = $state<string[][]>([]);
	manualAliasGroups = $state<string[][]>([]);
	baseFilterGroups = $derived(buildAliasFilterGroups(this.videos, this.identityAliasGroups, []));
	filterGroups = $derived(
		buildAliasFilterGroups(this.videos, this.identityAliasGroups, this.manualAliasGroups)
	);
	filteredVideos = $derived(
		filterByAliases(this.videos, expandSelectedAliases(this.selectedAliases, this.filterGroups))
	);

	epoch = 0;

	listIdentifiers = $state<Set<string>>(new Set());
	listLoading = $state(true);

	initialize(provider: string) {
		this.epoch++;
		this.selectedProvider = provider;
		this.isLoading = true;
		this.videos = [];
		this.listIdentifiers = new Set();
		this.listLoading = true;
		this.selectedAliases = new Set();
		this.identityAliasGroups = [];
		this.manualAliasGroups = this._loadManualAliasGroups(provider);
	}

	setVideos(videos: Video[]) {
		this.videos = videos;
		this.isLoading = false;
	}

	setLoading(loading: boolean) {
		this.isLoading = loading;
	}

	toggleFilterGroup(group: AliasFilterGroup) {
		const next = new Set(this.selectedAliases);
		const selected = group.aliases.some((alias) => next.has(alias));
		if (selected) {
			for (const alias of group.aliases) next.delete(alias);
		} else {
			for (const alias of group.aliases) next.add(alias);
		}
		this.selectedAliases = next;
	}

	removeFilterGroup(group: AliasFilterGroup) {
		const next = new Set(this.selectedAliases);
		for (const alias of group.aliases) next.delete(alias);
		this.selectedAliases = next;
	}

	addVideos(newVideos: Video[]) {
		if (newVideos.length === 0) return;
		const existing = new Set(this.videos.map((v) => v.filename + v.type));
		const toAdd = newVideos.filter((v) => !existing.has(v.filename + v.type));
		if (toAdd.length === 0) return;
		const merged = [...this.videos, ...toAdd];
		merged.sort((a, b) => a.filename.localeCompare(b.filename));
		this.videos = merged;
	}

	removeVideo(filename: string) {
		this.videos = this.videos.filter((v) => v.filename !== filename);
	}

	getLatestFilename(): string | null {
		if (this.videos.length === 0) return null;
		return this.videos[this.videos.length - 1].filename;
	}

	updateVideoLive(filename: string, isLive: boolean) {
		const target = this.videos.find((v) => v.filename === filename);
		if (!target || target.isLive === isLive) return;
		this.videos = this.videos.map((v) => (v.filename === filename ? { ...v, isLive } : v));
	}

	updateVideoType(filename: string, oldType: VideoType, newType: VideoType) {
		this.videos = this.videos.map((v) =>
			v.filename === filename && v.type === oldType ? { ...v, type: newType } : v
		);
	}
	setListIdentifiers(identifiers: string[]) {
		this.listIdentifiers = new Set(identifiers);
		this.listLoading = false;
	}

	setIdentityAliasGroups(groups: string[][]) {
		this.identityAliasGroups = this._normalizeAliasGroups(groups);
	}

	linkFilterGroups(source: AliasFilterGroup, target: AliasFilterGroup) {
		const linked = [...source.aliases, ...target.aliases];
		this.manualAliasGroups = this._normalizeAliasGroups([...this.manualAliasGroups, linked]);
		this._saveManualAliasGroups();
	}

	toggleManualLink(source: AliasFilterGroup, target: AliasFilterGroup) {
		if (this.areManuallyLinked(source, target)) {
			this.unlinkFilterGroups(source, target);
			return;
		}
		this.linkFilterGroups(source, target);
	}

	areManuallyLinked(source: AliasFilterGroup, target: AliasFilterGroup): boolean {
		return this.manualAliasGroups.some((manualGroup) => {
			const aliases = new Set(manualGroup);
			return (
				source.aliases.some((alias) => aliases.has(alias)) &&
				target.aliases.some((alias) => aliases.has(alias))
			);
		});
	}

	unlinkFilterGroups(source: AliasFilterGroup, target: AliasFilterGroup) {
		const sourceAliases = new Set(source.aliases);
		const targetAliases = new Set(target.aliases);
		const next = this.manualAliasGroups
			.flatMap((manualGroup) => {
				const hasSource = manualGroup.some((alias) => sourceAliases.has(alias));
				const hasTarget = manualGroup.some((alias) => targetAliases.has(alias));
				if (!hasSource || !hasTarget) return [manualGroup];
				return [manualGroup.filter((alias) => !targetAliases.has(alias))];
			})
			.filter((manualGroup) => manualGroup.length > 1);
		this.manualAliasGroups = this._normalizeAliasGroups(next);
		this._saveManualAliasGroups();
	}

	unlinkAliasFromGroup(group: AliasFilterGroup, alias: string) {
		if (group.aliases.length < 2) return;
		const remaining = group.aliases.filter((value) => value !== alias);
		const next = this.manualAliasGroups
			.map((manualGroup) => manualGroup.filter((value) => value !== alias))
			.filter((manualGroup) => manualGroup.length > 1);
		this.manualAliasGroups = this._normalizeAliasGroups([...next, remaining]);
		this._saveManualAliasGroups();
	}

	addListIdentifier(id: string) {
		this.listIdentifiers = new Set(this.listIdentifiers).add(id);
	}

	removeListIdentifier(id: string) {
		const next = new Set(this.listIdentifiers);
		next.delete(id);
		this.listIdentifiers = next;
	}

	private _manualStorageKey(provider = this.selectedProvider): string {
		return STORAGE_KEYS.FILTER_LINKS_PREFIX + provider;
	}

	private _loadManualAliasGroups(provider: string): string[][] {
		try {
			const raw = localStorage.getItem(this._manualStorageKey(provider));
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return this._normalizeAliasGroups(parsed);
		} catch {
			return [];
		}
	}

	private _saveManualAliasGroups() {
		localStorage.setItem(this._manualStorageKey(), JSON.stringify(this.manualAliasGroups));
	}

	private _normalizeAliasGroups(groups: unknown): string[][] {
		if (!Array.isArray(groups)) return [];
		const seen = new Set<string>();
		const normalized: string[][] = [];
		for (const group of groups) {
			if (!Array.isArray(group)) continue;
			const aliases = [
				...new Set(group.filter((alias): alias is string => typeof alias === 'string'))
			]
				.filter(Boolean)
				.sort((a, b) => a.localeCompare(b));
			if (aliases.length < 2) continue;
			const key = aliases.join('\u001f');
			if (seen.has(key)) continue;
			seen.add(key);
			normalized.push(aliases);
		}
		return normalized;
	}
}

export const videoListStore = new VideoListStore();
