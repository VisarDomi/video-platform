<script lang="ts">
	let {
		onaction
	}: {
		onaction: (action: string) => void;
	} = $props();

	const EDGE_ZONE = 30;

	function handlePointerDown(action: string, e: PointerEvent) {
		if (e.clientX <= EDGE_ZONE) return;
		onaction(action);
	}

	function preventTouchZoom(e: TouchEvent) {
		e.preventDefault();
	}
</script>

<div class="overlay" role="group" oncontextmenu={(e) => e.preventDefault()}>
	<!-- Row 1: prev / seek-backward -->
	<div
		class="quadrant top-quadrant"
		onpointerdown={(e) => handlePointerDown('prev', e)}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>
	<div
		class="quadrant top-quadrant"
		onpointerdown={(e) => handlePointerDown('seek-backward', e)}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>

	<!-- Row 2: next / seek-forward -->
	<div
		class="quadrant top-quadrant"
		onpointerdown={(e) => handlePointerDown('next', e)}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>
	<div
		class="quadrant top-quadrant"
		onpointerdown={(e) => handlePointerDown('seek-forward', e)}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>

	<!-- Row 3: toggle-ui (full width) -->
	<div
		class="quadrant bottom-quadrant"
		onpointerdown={(e) => handlePointerDown('toggle-ui', e)}
		role="button"
		tabindex="-1"
	></div>
</div>

<style>
	.overlay {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		display: grid;
		grid-template-columns: 1fr 1fr;
		grid-template-rows: 35% 35% 30%;
		z-index: 10;
	}

	.quadrant {
		-webkit-user-select: none;
		user-select: none;
		width: 100%;
		height: 100%;
	}

	.top-quadrant {
		touch-action: manipulation;
	}

	.bottom-quadrant {
		touch-action: auto;
		grid-column: 1 / span 2;
	}
</style>
