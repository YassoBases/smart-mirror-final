import { useEffect, useRef } from 'react';
import { saveFaceDescriptors, getFaceDescriptors, getUsers, saveProfiles, removeFaceDescriptor } from '../data/users';
import { backendApi } from '../services/backendApi';
import { getGeneralSettings } from '../data/generalSettings';

// Bundled locally (public/facedata) — same weights the live detector uses, served
// from the mirror itself so enrollment works offline and matches at runtime.
const FACE_MODEL_URL = `${process.env.PUBLIC_URL || ''}/facedata`;
const POLL_MS = 10_000; // re-check for new face uploads every 10 s

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForFaceApi(attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    if (window.faceapi) return window.faceapi;
    await delay(500);
  }
  return null;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Enrollment must use the SAME detector + landmark models as live detection
// (HandTrackingService: tinyFaceDetector + faceLandmark68TinyNet). The face
// descriptor depends on how the face is aligned from its landmarks, so mixing a
// full-size detector here with the tiny detector at runtime produces descriptors
// that don't match — the root cause of "it doesn't recognize me".
async function loadModels() {
  const faceapi = await waitForFaceApi();
  if (!faceapi) return false;
  try {
    const nets = faceapi.nets;
    if (!nets.tinyFaceDetector.isLoaded)
      await nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
    if (!nets.faceLandmark68TinyNet.isLoaded)
      await nets.faceLandmark68TinyNet.loadFromUri(FACE_MODEL_URL);
    if (!nets.faceRecognitionNet.isLoaded)
      await nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL);
    return true;
  } catch (e) {
    console.warn('[FaceEnroll] model load failed:', e.message);
    return false;
  }
}

async function descriptorFromUrl(url) {
  const faceapi = window.faceapi;
  if (!faceapi) return null;
  try {
    const img = await faceapi.fetchImage(url);
    // inputSize 320 (vs the runtime 224) gives a cleaner enrollment descriptor
    // from a still photo while still using the tiny detector/landmark pair.
    const det = await faceapi
      .detectSingleFace(
        img,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks(true)
      .withFaceDescriptor();
    return det?.descriptor ?? null;
  } catch (e) {
    console.warn('[FaceEnroll] descriptor failed for', url, e.message);
    return null;
  }
}

// Ensure the profile is in the mirror's local user list so findUserByFace()
// can resolve its name when a match is found.
function ensureProfileInUserList(backendId, name) {
  const mirrorId = `phone-${backendId}`;
  const { profiles } = getUsers();
  if (profiles.find((p) => p.id === mirrorId)) return;

  saveProfiles([
    ...profiles,
    { id: mirrorId, name, source: 'phone', backendId, faceEnrolled: true },
  ]);
  console.log('[FaceEnroll] Added user to mirror list:', name, mirrorId);
}

// Stable cache key: sorted filenames joined — changes only when the set of
// uploaded pose images changes.
function filesCacheKey(filenames) {
  return [...filenames].sort().join(',');
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const useFaceEnrollment = () => {
  const modelsReadyRef   = useRef(false);
  // Track which set of filenames has already been enrolled per user.
  const enrolledFilesRef = useRef({});   // { 'phone-1': 'file1.jpg,file2.jpg,file3.jpg' }

  useEffect(() => {
    const mirrorId = backendApi.getMirrorId();
    if (!mirrorId) return;

    const run = async () => {
      // Skip entirely when face recognition is off — no model load, no polling,
      // no descriptor inference. (Re-checked each tick; cheap.)
      if (!getGeneralSettings().faceRecognitionEnabled) return;

      // Load face-api.js models once
      if (!modelsReadyRef.current) {
        const ok = await loadModels();
        if (!ok) return;
        modelsReadyRef.current = true;
        console.log('[FaceEnroll] Models ready.');
      }

      // Fetch ALL profiles in this mirror's household (dynamic host via backendApi
      // — never hardcode localhost, or face-image fetches break off the kiosk).
      // Household-scoped (not just mirror-linked) so every family member is
      // enrolled and recognised by name, even if they never paired the mirror
      // from their own phone.
      let profiles;
      try {
        profiles = await backendApi.getHouseholdProfilesByMirror(mirrorId);
      } catch (e) {
        console.warn('[FaceEnroll] profile fetch failed:', e.message);
        return;
      }
      if (!profiles || profiles.length === 0) return;

      const existingDescriptors = getFaceDescriptors();

      for (const p of profiles) {
        // Prefer the multi-pose array; fall back to legacy single filename
        let filenames = [];
        if (p.face_filenames) {
          try { filenames = JSON.parse(p.face_filenames); } catch { filenames = []; }
        }
        if (filenames.length === 0 && p.face_filename) {
          filenames = [p.face_filename];
        }
        if (filenames.length === 0) continue;

        const mirrorUserId = `phone-${p.id}`;
        const cacheKey = filesCacheKey(filenames);
        const alreadyEnrolled =
          enrolledFilesRef.current[mirrorUserId] === cacheKey &&
          existingDescriptors[mirrorUserId];

        if (alreadyEnrolled) continue;

        console.log(`[FaceEnroll] Processing ${filenames.length} pose(s) for ${p.name}`);

        // Compute descriptor for each pose image
        const descriptors = [];
        for (const filename of filenames) {
          const faceUrl = backendApi.faceImageUrl(filename);
          const descriptor = await descriptorFromUrl(faceUrl);
          if (descriptor) {
            descriptors.push(descriptor);
            console.log(`[FaceEnroll] ✓ ${filename}`);
          } else {
            console.warn(`[FaceEnroll] ✗ no face in ${filename}`);
          }
        }

        if (descriptors.length === 0) {
          console.warn(`[FaceEnroll] No face detected in any photo for ${p.name}`);
          continue;
        }

        saveFaceDescriptors(mirrorUserId, descriptors);
        enrolledFilesRef.current[mirrorUserId] = cacheKey;
        ensureProfileInUserList(p.id, p.name);
        console.log(
          `[FaceEnroll] Enrolled: ${p.name} — ${descriptors.length}/${filenames.length} poses matched`
        );
      }

      // Reconcile the local member list with the household: drop any phone
      // profiles (and their descriptors) no longer present in the household, so
      // deletions on the phone propagate and stale faces stop matching. This
      // hook owns "who exists"; useActiveUser only tracks "who is active".
      const householdIds = new Set(profiles.map((p) => `phone-${p.id}`));
      const { profiles: localList } = getUsers();
      const removed = localList.filter(
        (p) => p.source === 'phone' && !householdIds.has(p.id),
      );
      if (removed.length > 0) {
        const removedIds = new Set(removed.map((p) => p.id));
        removed.forEach((p) => removeFaceDescriptor(p.id));
        saveProfiles(localList.filter((p) => !removedIds.has(p.id)));
        console.log(
          '[FaceEnroll] Removed profiles no longer in household:',
          removed.map((p) => p.name),
        );
      }
    };

    run();
    const id = setInterval(run, POLL_MS);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
};

export default useFaceEnrollment;
