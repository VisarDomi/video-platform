import { SWIPE_THRESHOLD, DEADZONE_RATIO } from '$lib/constants.js';
import { appDimensions } from '$lib/state/appDimensions';

interface SwipeableParams {
	providers: readonly string[];
	getProvider: () => string;
	onSwitch: (dir: 1 | -1) => void;
	isEnabled?: () => boolean;
}

export function swipeable(node: HTMLElement, params: SwipeableParams) {
	const { providers, getProvider, onSwitch, isEnabled } = params;

	let swipeStartX = 0;
	let swipeStartY = 0;
	let swipeAxis: 'none' | 'horizontal' | 'vertical' = 'none';
	let isSwiping = false;
	let swipeAnimating = false;

	function getAdjacentProvider(dir: 1 | -1): string | null {
		const idx = providers.indexOf(getProvider());
		const newIdx = idx + dir;
		if (newIdx < 0 || newIdx >= providers.length) return null;
		return providers[newIdx];
	}

	function handleTouchStart(e: TouchEvent) {
		if (isEnabled && !isEnabled()) return;
		if (swipeAnimating) return;
		swipeStartX = e.touches[0].clientX;
		swipeStartY = e.touches[0].clientY;
		swipeAxis = 'none';
		isSwiping = false;
	}

	function handleTouchMove(e: TouchEvent) {
		if (isEnabled && !isEnabled()) return;
		if (swipeAnimating) return;
		if (swipeAxis === 'vertical') return;

		const touch = e.touches[0];
		const dx = touch.clientX - swipeStartX;
		const dy = touch.clientY - swipeStartY;

		if (swipeAxis === 'none') {
			const deadzone = appDimensions.width * DEADZONE_RATIO;
			if (Math.abs(dx) < deadzone && Math.abs(dy) < deadzone) return;
			if (Math.abs(dy) > Math.abs(dx)) {
				swipeAxis = 'vertical';
				return;
			}
			swipeAxis = 'horizontal';
			isSwiping = true;
		}

		e.preventDefault();

		const dir: 1 | -1 = dx < 0 ? 1 : -1;
		const adjacent = getAdjacentProvider(dir);
		node.style.transition = 'none';
		node.style.transform = adjacent
			? `translateX(${dx}px)`
			: `translateX(${dx * 0.3}px)`;
	}

	function handleTouchEnd(e: TouchEvent) {
		if (swipeAxis !== 'horizontal' || !isSwiping) {
			swipeAxis = 'none';
			isSwiping = false;
			return;
		}

		const dx = e.changedTouches[0].clientX - swipeStartX;
		const dir: 1 | -1 = dx < 0 ? 1 : -1;
		const adjacent = getAdjacentProvider(dir);

		if (Math.abs(dx) > appDimensions.width * SWIPE_THRESHOLD && adjacent) {
			animateProviderSwitch(dir);
		} else {
			node.style.transition = 'transform 250ms ease-out';
			node.style.transform = 'translateX(0)';
			setTimeout(() => {
				node.style.transition = '';
				node.style.transform = '';
				isSwiping = false;
				swipeAxis = 'none';
			}, 250);
		}
	}

	function handleTouchCancel() {
		node.style.transition = '';
		node.style.transform = '';
		swipeAxis = 'none';
		isSwiping = false;
	}

	function animateProviderSwitch(direction: 1 | -1) {
		swipeAnimating = true;
		const vw = window.innerWidth;
		const slideOutTarget = direction > 0 ? -vw : vw;

		node.style.transition = 'transform 250ms ease-out';
		node.style.transform = `translateX(${slideOutTarget}px)`;

		setTimeout(() => {
			node.style.transition = 'none';
			node.style.transform = `translateX(${-slideOutTarget}px)`;
			onSwitch(direction);

			requestAnimationFrame(() => {
				node.style.transition = 'transform 250ms ease-out';
				node.style.transform = 'translateX(0)';
				setTimeout(() => {
					node.style.transition = '';
					node.style.transform = '';
					isSwiping = false;
					swipeAnimating = false;
					swipeAxis = 'none';
				}, 250);
			});
		}, 250);
	}

	node.addEventListener('touchstart', handleTouchStart);
	node.addEventListener('touchmove', handleTouchMove, { passive: false });
	node.addEventListener('touchend', handleTouchEnd);
	node.addEventListener('touchcancel', handleTouchCancel);

	return {
		destroy() {
			node.removeEventListener('touchstart', handleTouchStart);
			node.removeEventListener('touchmove', handleTouchMove);
			node.removeEventListener('touchend', handleTouchEnd);
			node.removeEventListener('touchcancel', handleTouchCancel);
		}
	};
}
