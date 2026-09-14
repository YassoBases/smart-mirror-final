import { renderHook, act, waitFor } from '@testing-library/react';
import { useGarmentRecognition } from './useGarmentRecognition';
import { getCameraVideo } from '../../services/cameraStream';
import { startPoseTracking, stopPoseTracking } from '../../services/poseTracking';
import { wardrobeApi } from './wardrobeApi';
import { torsoBounds } from './garmentLayer';

jest.mock('../../services/cameraStream', () => ({ getCameraVideo: jest.fn() }));
jest.mock('../../services/poseTracking', () => ({ startPoseTracking: jest.fn(), stopPoseTracking: jest.fn() }));
jest.mock('./garmentLayer', () => ({ torsoBounds: jest.fn() }));
jest.mock('./wardrobeApi', () => ({ wardrobeApi: { recognizeGarment: jest.fn(), enrollGarment: jest.fn() } }));

const STABLE_MS = 1200;
const BURST_FRAMES = 3;
const BURST_INTERVAL_MS = 350;

function fakePose(visible) {
  return { visible, landmarks: { leftShoulder: {}, rightShoulder: {}, leftHip: {}, rightHip: {} } };
}

describe('useGarmentRecognition', () => {
  let onResult;
  let getContextSpy, toBlobSpy;

  beforeEach(() => {
    jest.useFakeTimers();
    getCameraVideo.mockReturnValue({ videoWidth: 640, videoHeight: 480 });
    startPoseTracking.mockImplementation((video, cb) => { onResult = cb; return { ready: Promise.resolve(true) }; });
    // CRA's jest config sets resetMocks:true, which clears every mock's
    // implementation (not just call history) before each test — including the
    // ones set by the jest.mock(...) factories above — so this has to be
    // re-established here, not just once at module load.
    torsoBounds.mockReturnValue({ left: .2, top: .1, right: .8, bottom: .9 });
    // Targeted spies, restored individually below — jest.restoreAllMocks() would
    // also wipe the jest.mock(...) factory implementations above (e.g.
    // torsoBounds), not just these two.
    getContextSpy = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: jest.fn() });
    toBlobSpy = jest.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob(['frame'], { type: 'image/jpeg' }));
    });
    wardrobeApi.recognizeGarment.mockReset();
    wardrobeApi.enrollGarment.mockReset();
  });
  afterEach(() => { jest.useRealTimers(); getContextSpy.mockRestore(); toBlobSpy.mockRestore(); });

  // The hook only re-checks elapsed stable-time from inside the pose callback
  // itself (advancing fake timers alone doesn't re-invoke it), so this sends a
  // pose sample, moves the clock, then sends another sample to let the hook
  // notice — then keeps advancing through the burst-capture delays inside
  // runCheck (which real setTimeouts, faked, gate).
  async function driveToDecision() {
    act(() => onResult(fakePose(true)));
    act(() => { jest.advanceTimersByTime(STABLE_MS + 50); });
    await act(async () => { onResult(fakePose(true)); });
    for (let i = 0; i < BURST_FRAMES; i++) {
      await act(async () => { jest.advanceTimersByTime(BURST_INTERVAL_MS + 10); });
    }
  }

  test('does nothing when disabled, or when no camera is published', () => {
    getCameraVideo.mockReturnValue(null);
    renderHook(() => useGarmentRecognition({ enabled: true }));
    expect(startPoseTracking).not.toHaveBeenCalled();

    getCameraVideo.mockReturnValue({ videoWidth: 640, videoHeight: 480 });
    renderHook(() => useGarmentRecognition({ enabled: false }));
    expect(startPoseTracking).not.toHaveBeenCalled();
  });

  test('does not capture before presence has been stable for the required window', () => {
    const { result } = renderHook(() => useGarmentRecognition({ enabled: true }));
    act(() => onResult(fakePose(true)));
    act(() => { jest.advanceTimersByTime(STABLE_MS - 100); });
    expect(result.current.phase).toBe('idle');
    expect(wardrobeApi.recognizeGarment).not.toHaveBeenCalled();
  });

  test('recognized: shows the matched item without ever prompting to add it', async () => {
    wardrobeApi.recognizeGarment.mockResolvedValue({
      status: 'recognized', similarity: 0.93,
      item: { id: 1, category: 'top', subcategory: 'tshirts', primaryColor: '#000', thumbnailUrl: '/t.jpg' },
    });
    const { result } = renderHook(() => useGarmentRecognition({ enabled: true }));
    await driveToDecision();
    await waitFor(() => expect(result.current.phase).toBe('recognized'));
    expect(result.current.result.item.id).toBe(1);
    expect(wardrobeApi.recognizeGarment).toHaveBeenCalledTimes(1);
    const frames = wardrobeApi.recognizeGarment.mock.calls[0][0];
    expect(frames).toHaveLength(BURST_FRAMES);
    expect(wardrobeApi.enrollGarment).not.toHaveBeenCalled();
  });

  test('unknown: prompts once; declining never calls enroll and never stores anything', async () => {
    wardrobeApi.recognizeGarment.mockResolvedValue({ status: 'unknown', similarity: 0.2 });
    const { result } = renderHook(() => useGarmentRecognition({ enabled: true }));
    await driveToDecision();
    await waitFor(() => expect(result.current.phase).toBe('confirming'));

    await act(async () => { await result.current.confirm(false); });
    expect(result.current.phase).toBe('idle');
    expect(wardrobeApi.enrollGarment).not.toHaveBeenCalled();
  });

  test('unknown + confirm: shows progress, then enrolls and shows what was added', async () => {
    wardrobeApi.recognizeGarment.mockResolvedValue({ status: 'unknown', similarity: 0.1 });
    let resolveEnroll;
    wardrobeApi.enrollGarment.mockReturnValue(new Promise((r) => { resolveEnroll = r; }));
    const { result } = renderHook(() => useGarmentRecognition({ enabled: true }));
    await driveToDecision();
    await waitFor(() => expect(result.current.phase).toBe('confirming'));

    // Nothing was captured/stored before this explicit confirm.
    expect(wardrobeApi.enrollGarment).not.toHaveBeenCalled();
    let confirmPromise;
    act(() => { confirmPromise = result.current.confirm(true); });
    expect(result.current.phase).toBe('enrolling');

    act(() => resolveEnroll({ item: { id: 9, category: 'bottom', subcategory: 'jeans', thumbnailUrl: '/j.jpg' } }));
    await act(async () => { await confirmPromise; });
    expect(result.current.phase).toBe('added');
    expect(result.current.result.item.id).toBe(9);
    expect(wardrobeApi.enrollGarment).toHaveBeenCalledTimes(1);
  });

  test('one decision per presence session: a still-present person is not re-checked repeatedly', async () => {
    wardrobeApi.recognizeGarment.mockResolvedValue({ status: 'unknown', similarity: 0.1 });
    renderHook(() => useGarmentRecognition({ enabled: true }));
    await driveToDecision();
    await waitFor(() => expect(wardrobeApi.recognizeGarment).toHaveBeenCalledTimes(1));

    // Still visible, long after the stable window and the prompt timeout —
    // must not fire a second check while the same person hasn't left.
    act(() => onResult(fakePose(true)));
    await act(async () => { jest.advanceTimersByTime(20000); });
    act(() => onResult(fakePose(true)));
    expect(wardrobeApi.recognizeGarment).toHaveBeenCalledTimes(1);
  });

  test('stops pose tracking on unmount/disable', () => {
    const { unmount } = renderHook(() => useGarmentRecognition({ enabled: true }));
    unmount();
    expect(stopPoseTracking).toHaveBeenCalled();
  });
});
