import type { Provider } from '../constants.js';

export class TextEditorPage {
	private readonly textarea = document.createElement('textarea');
	private readonly message = document.createElement('p');
	private readonly save = document.createElement('button');

	constructor(private readonly provider: Provider) {}

	async open(): Promise<void> {
		document.title = `${this.provider.toUpperCase()} Links Editor`;
		const main = document.createElement('main');
		main.className = 'text-editor';
		const heading = document.createElement('h1');
		heading.textContent = `${this.provider.toUpperCase()} Links Editor`;
		this.textarea.spellcheck = false;
		this.textarea.placeholder = 'Loading…';
		this.save.type = 'button';
		this.save.textContent = 'Save';
		this.save.addEventListener('click', () => void this.saveContent());
		this.message.className = 'editor-message';
		main.append(heading, this.textarea, this.save, this.message);
		document.body.replaceChildren(main);
		await this.load();
	}

	private async load(): Promise<void> {
		try {
			const response = await fetch(`/api/${this.provider}`);
			if (!response.ok) throw new Error(`Load failed: ${response.status}`);
			this.textarea.value = await response.text();
			this.textarea.placeholder = '';
		} catch (error) {
			this.showError(error);
		}
	}

	private async saveContent(): Promise<void> {
		this.save.disabled = true;
		this.message.className = 'editor-message';
		this.message.textContent = 'Saving…';
		try {
			const response = await fetch(`/api/${this.provider}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: this.textarea.value })
			});
			if (!response.ok) throw new Error(`Save failed: ${response.status}`);
			this.message.textContent = 'Saved.';
		} catch (error) {
			this.showError(error);
		} finally {
			this.save.disabled = false;
		}
	}

	private showError(error: unknown): void {
		console.error(error);
		this.message.className = 'editor-message error';
		this.message.textContent = error instanceof Error ? error.message : 'Request failed.';
	}
}
