<script lang="ts">
	let {
		onaction
	}: {
		onaction: (action: string) => void;
	} = $props();

	function handlePointerDown(action: string) {
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
		onpointerdown={() => handlePointerDown('prev')}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>
	<div
		class="quadrant top-quadrant"
		onpointerdown={() => handlePointerDown('seek-backward')}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>

	<!-- Row 2: next / seek-forward -->
	<div
		class="quadrant top-quadrant"
		onpointerdown={() => handlePointerDown('next')}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>
	<div
		class="quadrant top-quadrant"
		onpointerdown={() => handlePointerDown('seek-forward')}
		ontouchend={preventTouchZoom}
		role="button"
		tabindex="-1"
	></div>

	<!-- Row 3: toggle-ui (full width) -->
	<div
		class="quadrant bottom-quadrant"
		onpointerdown={() => handlePointerDown('toggle-ui')}
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
