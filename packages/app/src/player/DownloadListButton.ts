// The PC download-list +/- button of Tango (formerly Stream Viewer), shared by the viewer (local
// apps, Tango, Video Vault) and the FC2/SC live extensions' bar: ⏳ while checking or changing,
// ➕/➖, ⚠️ when the list cannot be read, and a yellow ring when a change failed (keeping the last
// confirmed state). The reason is the tooltip. Where a change can go to several lists (Video
// Vault's uploads), the button gives way to one button per list until one is picked, and 🔍
// says none has the streamer. Styles: buttons.css. No other app imports, so the extensions can
// bundle it.

export type MembershipState =
	| { state: 'none' }
	| { state: 'loading' }
	| { state: 'ready'; isMember: boolean }
	| { state: 'choosing'; confirmedMember: boolean; targets: readonly string[] }
	| { state: 'notFound' }
	| { state: 'adding'; confirmedMember: false }
	| { state: 'removing'; confirmedMember: true }
	| { state: 'unavailable'; message: string }
	| { state: 'error'; confirmedMember: boolean; message: string };

// A streamer and the download list it belongs in; each host supplies how to reach the list.
// The server answers membership by the streamer's ID, so a name from before a rename counts.
export interface Membership {
	isMember(): Promise<boolean>;
	change(add: boolean, target?: string): Promise<void>;
	// Hosts with several lists (Video Vault): the lists, by name, a change can go to. None found
	// shows 🔍; a failed lookup throws (⚠️).
	targets?(add: boolean): Promise<readonly string[]>;
}

export class DownloadListButton {
	// The button, or one button per list while choosing.
	readonly element = document.createElement('span');
	private readonly button = document.createElement('button');
	private state: MembershipState = { state: 'none' };
	private membership: Membership | null = null;
	private token = 0;
	private enabled = true;

	constructor() {
		this.element.className = 'list-control';
		this.button.type = 'button';
		this.button.addEventListener('click', () => void this.toggle());
		this.element.append(this.button);
		this.render();
	}

	// Shows a streamer's membership; none (null) hides the button. A newer call replaces this one.
	async show(membership: Membership | null | Promise<Membership | null>): Promise<void> {
		const token = ++this.token;
		this.membership = null;
		this.set({ state: 'none' });
		try {
			const shown = await membership;
			if (!shown || token !== this.token) return;
			this.set({ state: 'loading' });
			const isMember = await shown.isMember();
			if (token !== this.token) return;
			this.membership = shown;
			this.set({ state: 'ready', isMember });
		} catch (error) {
			if (token === this.token) this.set({ state: 'unavailable', message: reason(error, 'Membership fetch failed') });
		}
	}

	// The viewer disables its controls while a swipe settles.
	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		this.render();
	}

	private async toggle(): Promise<void> {
		const membership = this.membership;
		if (!membership || (this.state.state !== 'ready' && this.state.state !== 'error')) return;
		const confirmed = this.state.state === 'ready' ? this.state.isMember : this.state.confirmedMember;
		if (!membership.targets) return this.change(!confirmed);
		const token = ++this.token;
		this.set(confirmed ? { state: 'removing', confirmedMember: true } : { state: 'adding', confirmedMember: false });
		try {
			const targets = await membership.targets(!confirmed);
			if (token !== this.token) return;
			if (targets.length === 1) return this.change(!confirmed, targets[0]);
			this.set(targets.length ? { state: 'choosing', confirmedMember: confirmed, targets } : { state: 'notFound' });
		} catch (error) {
			if (token === this.token) this.set({ state: 'unavailable', message: reason(error, 'Lookup failed') });
		}
	}

	// Membership is asked again to confirm a change.
	private async change(add: boolean, target?: string): Promise<void> {
		const membership = this.membership;
		if (!membership) return;
		const token = ++this.token;
		this.set(add ? { state: 'adding', confirmedMember: false } : { state: 'removing', confirmedMember: true });
		try {
			await membership.change(add, target);
			const isMember = await membership.isMember();
			if (token !== this.token) return;
			this.set({ state: 'ready', isMember });
		} catch (error) {
			if (token !== this.token) return;
			this.set({ state: 'error', confirmedMember: !add, message: reason(error, 'Membership update failed') });
		}
	}

	private set(state: MembershipState): void {
		this.state = state;
		this.render();
	}

	private render(): void {
		const { button, state } = this;
		const isMember = state.state === 'ready' ? state.isMember : state.state === 'error' ? state.confirmedMember : null;
		button.hidden = state.state === 'none' || state.state === 'choosing';
		button.disabled = !this.enabled || isMember === null;
		button.textContent = state.state === 'unavailable' ? '⚠️' : state.state === 'notFound' ? '🔍'
			: isMember === null ? '⏳' : isMember ? '➖' : '➕';
		button.title = state.state === 'unavailable' || state.state === 'error' ? state.message
			: state.state === 'notFound' ? 'No provider has a streamer by this name' : '';
		button.classList.toggle('list-add', isMember === false);
		button.classList.toggle('list-remove', isMember === true);
		button.classList.toggle('list-error', state.state === 'unavailable' || state.state === 'error');
		const choices = state.state !== 'choosing' ? [] : state.targets.map(target => {
			const choice = document.createElement('button');
			choice.type = 'button';
			choice.textContent = target;
			choice.className = `list-choice ${state.confirmedMember ? 'list-remove' : 'list-add'}`;
			choice.disabled = !this.enabled;
			choice.addEventListener('click', () => void this.change(!state.confirmedMember, target));
			return choice;
		});
		this.element.replaceChildren(button, ...choices);
	}
}

function reason(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}
