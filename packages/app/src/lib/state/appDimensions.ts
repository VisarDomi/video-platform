const isClient = typeof screen !== 'undefined';
export const appDimensions = { width: isClient ? screen.width : 390, height: isClient ? screen.height : 844 };

function update() {
	appDimensions.width = screen.width;
	appDimensions.height = screen.height;
	document.documentElement.style.setProperty('--app-width', screen.width + 'px');
	document.documentElement.style.setProperty('--app-height', screen.height + 'px');
}

export function initAppDimensions() {
	update();
	window.addEventListener('resize', update);
}
