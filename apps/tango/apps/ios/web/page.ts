import css from '../../../src/style.css?inline';
export { showStatus } from '../../../src/core/page';
export function takeOverPage(): void {
    document.body.replaceChildren();
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
}
