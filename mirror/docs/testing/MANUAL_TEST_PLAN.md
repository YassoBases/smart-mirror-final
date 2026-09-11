# Manual Test Plan

Cross-checked against [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) — items below
target the flows that matrix marks as needing hardware or human judgment, on
top of what the automated suites (`backend/__tests__/*`,
`src/**/*.test.jsx`, `services/smoke_http.py`) already cover.

This round is being run from a laptop against the backend + web build, not
the physical mirror. **Out of scope this round, explicitly (not forgotten):**
anything requiring the Raspberry Pi itself — BLE Wi-Fi provisioning from
real hardware, kiosk cold-boot, and the six-hour unattended-stability soak.
Those are called out again at the point they'd normally appear below.

Columns: **#**, **Step**, **Expected result**, **Pass/Fail**.

---

## 1. BLE provisioning (Raspberry Pi hardware — OUT OF SCOPE this round)

Requires a factory-state Pi and a phone on-site. Not testable from a laptop.
Listed for completeness per `provisioning routes; provisioning Linux units;
BLE/connectivity screens` in the feature matrix — do not delete, do not
attempt to fake with a mock BLE stack.

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 1.1 | Power on a factory-reset mirror | Mirror advertises BLE provisioning service | — out of scope — |
| 1.2 | Phone app scans and connects via BLE | Phone lists mirror, prompts for Wi-Fi credentials | — out of scope — |
| 1.3 | Submit Wi-Fi SSID/password over BLE | Mirror joins network, BLE advertising stops | — out of scope — |
| 1.4 | From Settings, trigger "change network" | Mirror re-enters BLE provisioning mode without a factory reset | — out of scope — |

---

## 2. QR / short-code pairing

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 2.1 | Fresh mirror boots to pairing screen | QR code and short numeric code both rendered | |
| 2.2 | Scan QR from the phone app | Phone links to the household; mirror transitions out of pairing phase | |
| 2.3 | Re-scan the **same** QR code a second time | Pairing is rejected (single-use) — mirror does not re-pair or duplicate the link | |
| 2.4 | Enter the short code manually instead of scanning | Same successful pairing result as 2.2 | |
| 2.5 | Kill the mirror's network mid-pairing, then restore it | Mirror recovers without requiring a fresh factory reset; pairing session either resumes or cleanly re-issues a new QR/code | |
| 2.6 | After pairing, force the phone app to send `resync` over the mirror-sync WebSocket | Per [E2E_FINDINGS.md](./E2E_FINDINGS.md#3-websocket-resync-returns-an-empty-module-snapshot-state-actually-flows-over-http-polling) this returns an empty snapshot by design-gap; confirm the mirror's on-screen state is still correct a moment later via HTTP polling, not stuck showing stale data | |

---

## 3. Face enrollment and recognition

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 3.1 | Enroll a new face from the phone app (face_setup) | Enrollment succeeds; profile now has a face descriptor | |
| 3.2 | Enrolled person stands in front of the mirror | Mirror recognizes them within a few frames, greets by name, sets them as active profile | |
| 3.3 | A second enrolled person (different household profile) steps in | Mirror switches active profile with no leftover state from the first person (cross-check against the profile-switch race fix in [E2E_FINDINGS.md](./E2E_FINDINGS.md#1-profile-switch-race-stale-wardrobe-response-repopulates-state-after-switch)) | |
| 3.4 | An unenrolled person stands in front of the mirror | Mirror shows "Unknown" state, does not misattribute to an enrolled profile | |
| 3.5 | Everyone steps away | Mirror returns to idle/scanning state | |

---

## 4. Unknown-person alerts

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 4.1 | Unknown face lingers in frame past the detection threshold | Backend records an unknown-face alert with a snapshot | |
| 4.2 | Household member's phone has push notifications enabled | Push notification is delivered for the alert | |
| 4.3 | Open Alerts screen on phone | Alert appears with snapshot and timestamp, matches step 4.1 | |
| 4.4 | Same unknown face lingers again shortly after | Confirm alert de-duplication/rate behavior is sane (no notification storm) — record actual behavior even if not formally specified | |

---

## 5. Hands-free gestures and pinch cursor

Per `gestureMap.js` (see also `flows.test.jsx`'s dispatch-level coverage,
which tests the event handlers but not real hand tracking):

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 5.1 | Open palm held in view (wardrobe closed) | Nothing happens — open-palm invoke is intentionally unbound for wardrobe (button-driven only, see `index.jsx` comment) | |
| 5.2 | With outfit board open, swipe hand left-to-right past ~30% of screen width | `next_outfit` fires, board advances | |
| 5.3 | Make a fist and hold in view | `dismiss` fires, wardrobe session closes | |
| 5.4 | Pinch gesture over an on-screen button (e.g. "Try it on me") | Cursor overlay tracks hand position; pinch triggers the same action a real click would | |
| 5.5 | Pinch over empty space (no actionable element under cursor) | No action fires; no crash or stuck cursor state | |

---

## 6. Voice assistant

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 6.1 | Invoke voice assistant, ask a simple question | Assistant responds with relevant audio/text | |
| 6.2 | Ask a follow-up question referencing the previous answer | Assistant maintains context across the follow-up | |
| 6.3 | Disconnect network mid-conversation, then ask a question | Assistant fails visibly/gracefully (clear error state), does not hang silently or crash the overlay | |
| 6.4 | Restore network after 6.3 | Assistant recovers on next invocation without requiring a mirror restart | |

---

## 7. Garment capture → attributes → correction

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 7.1 | Photograph a real garment via the phone app's capture flow | Item is created; background removal runs (see [E2E_FINDINGS.md](./E2E_FINDINGS.md#5-bg_remover-degrades-to-the-original-non-background-removed-image-when-the-u2net-model-isnt-cached) for the documented cold-start fallback) | |
| 7.2 | Wait for classification to complete | Category, subcategory, color, pattern, formality, warmth, seasons are populated with plausible values for the real garment | |
| 7.3 | Manually correct one or more attributes (e.g. wrong category) in item_editor_screen | Correction saves | |
| 7.4 | Re-open the item | Manual correction persists — is not silently overwritten by a later re-classification | |
| 7.5 | Delete the item | Item and its images are removed; no longer appears in browse or in future suggestions | |

---

## 8. Outfit recommendation → feedback → recommendation changes

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 8.1 | Request an outfit suggestion ("From my closet") | A candidate outfit with reasoning text is shown | |
| 8.2 | Give negative feedback on the suggestion | Feedback is recorded (`pref_ranker` train call) | |
| 8.3 | Repeat 8.2 several times with a consistent preference (e.g. always reject the same category) | Later suggestions visibly shift away from the rejected pattern — cross-check against `pref_ranker`'s heuristic→learned transition verified in `services/smoke_http.py` | |
| 8.4 | Check feedback history screen | All given feedback is listed accurately | |

---

## 9. Still try-on, then live try-on with real movement

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 9.1 | Select an outfit, request try-on with Live toggle **off** | Still rendered image displays | |
| 9.2 | Toggle Live **on** with a real body in frame and pose tracking available | Live camera canvas appears, garment warps onto the live pose in real time | |
| 9.3 | Move/rotate torso up to ~25° while Live is on | Garment warp tracks the movement smoothly (transform is unit-tested to ±25° in `warpGarment.test.js` — confirm it holds up visually with a real body, not just the synthetic test geometry) | |
| 9.4 | Wait through a keyframe refresh cycle while Live is on | New still keyframe fetches in the background; live warp continues on the old layer until the new one is ready, then swaps — no visible freeze or flash | |
| 9.5 | Toggle Live **off** again | Falls back to the identical still image from 9.1, no stuck camera feed | |
| 9.6 | Disable/block pose tracking (e.g. camera permission denied) and toggle Live **on** | Falls back to still image and visibly explains why (per the `window.__LIVE_TRYON_DISABLE_POSE__` fallback path tested in `flows.test.jsx`) rather than showing a blank or broken view | |
| 9.7 | Observe alignment right when a fresh still keyframe arrives vs. the live pose at that instant | Note any visible misalignment — this is the documented architectural limitation in [E2E_FINDINGS.md](./E2E_FINDINGS.md#4-live-try-on-warp-reference-pose-can-mismatch-the-live-pose-at-keyframe-arrival) (saved-photo pose vs. live pose), not a new bug; record how noticeable it is in practice | |

---

## 10. Two-profile switching with no data bleed

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 10.1 | Profile A opens wardrobe, browses items, requests a suggestion | A's items and suggestion appear | |
| 10.2 | While A's request is in flight, switch active profile to B (face recognition or manual) | Wardrobe resets to idle for B; A's in-flight response, once it resolves, does not repopulate the screen (regression-tested in `flows.test.jsx`, see [E2E_FINDINGS.md](./E2E_FINDINGS.md#1-profile-switch-race-stale-wardrobe-response-repopulates-state-after-switch)) | |
| 10.3 | B browses their own wardrobe | Only B's items/body photo/history appear — none of A's | |
| 10.4 | Switch back to A | A's own data reappears correctly, not B's | |
| 10.5 | Check alerts/history screens for both profiles | Each profile's history is scoped to itself only | |

---

## 11. Connection gate and offline recovery

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 11.1 | Start the mirror app with the backend unreachable | Connection gate / offline state shown, not a blank screen or crash | |
| 11.2 | Bring the backend up while the mirror app is already running | App recovers without requiring a manual reload | |
| 11.3 | With backend reachable, individually kill each Python service (`wardrobe_attr`, `bg_remover`, `pref_ranker`) one at a time and exercise the dependent feature | Each degrades per its documented fallback (stub attributes, original image, heuristic ranking) rather than crashing the request | |

---

## 12. Unattended startup, kiosk cold-boot, long-running stability (Raspberry Pi hardware — OUT OF SCOPE this round)

Requires the physical Pi running the kiosk deployment unit and a multi-hour
unattended window. Not testable from a laptop this round.

| # | Step | Expected result | Pass/Fail |
|---|---|---|---|
| 12.1 | Cold-boot the Pi from power-off | Kiosk reaches the mirror UI without manual intervention | — out of scope — |
| 12.2 | Leave the mirror running unattended for 6 hours | No memory growth, crash, or visual degradation | — out of scope — |
