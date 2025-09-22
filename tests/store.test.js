// tests/store.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// We need to import the actual store to test it
import { store } from '../public/modules/store.js';

// Mock the dependencies of the store so we only test the store's logic
vi.mock('../public/modules/api.js', () => ({
  fetchVideos: vi.fn(),
  fetchVideoDurations: vi.fn(),
  sendDeleteRequest: vi.fn(),
  sendEditRequest: vi.fn(),
}));

vi.mock('../public/modules/player.js', () => ({
  navigateToVideo: vi.fn(),
}));

vi.mock('../public/modules/ui.js', () => ({
  showToast: vi.fn(),
}));

// A helper to reset the store's internal state before each test
function resetStoreState() {
  // This is a simplified reset. In a real scenario, you might need a dedicated
  // reset function inside the store module itself for testing.
  // For now, we can re-initialize a baseline state.
  store.actions.playVideo({ filename: 'test.mp4', type: 'original' });
}


describe('store.js - Editing Logic', () => {
  beforeEach(() => {
    // Clear any mocks and reset the store state before each test runs
    vi.clearAllMocks();
    resetStoreState();
  });

  it('should add a segment point and keep the list sorted', () => {
    // Arrange: Get the initial state
    const initialState = store.getState();
    expect(initialState.segments).toEqual([]);

    // Act: Add points out of order
    store.actions.addSegment(10.5);
    store.actions.addSegment(5.2);
    store.actions.addSegment(15.0);

    // Assert: The segments array should now contain the points, sorted numerically
    const finalState = store.getState();
    expect(finalState.segments).toEqual([5.2, 10.5, 15.0]);
  });

  it('should not add a segment if the video is not an "original" type', () => {
    // Arrange: Play an "edited" video
    store.actions.playVideo({ filename: 'test-edited.mp4', type: 'edited' });
    const initialState = store.getState();
    expect(initialState.segments).toEqual([]);

    // Act: Try to add a segment
    store.actions.addSegment(10.0);

    // Assert: The segments array should still be empty
    const finalState = store.getState();
    expect(finalState.segments).toEqual([]);
  });

  it('should remove the last segment point', () => {
    // Arrange: Add a few segments
    store.actions.addSegment(10);
    store.actions.addSegment(20);
    expect(store.getState().segments).toHaveLength(2);

    // Act: Remove the last one
    store.actions.removeLastSegment();

    // Assert: The segments array should have one less item
    const finalState = store.getState();
    expect(finalState.segments).toEqual([10]);
    expect(finalState.segments).toHaveLength(1);
  });
});