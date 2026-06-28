import { useState, useEffect, useCallback, useRef } from 'react';
import { getUsers, setActiveUser, saveProfiles } from '../data/users';
import { backendApi } from '../services/backendApi';

/**
 * useActiveUser()
 *
 * Returns the active user profile and a stable switchUser function.
 * Reacts to 'smartMirror:activeUserChanged' events so any component
 * that calls this hook updates automatically when another part of the
 * app switches the user.
 *
 * Usage:
 *   const { activeUser, allUsers, switchUser } = useActiveUser();
 *
 * Future:
 *   activeUser.gmailConnected  → drive per-user Gmail widget
 *   activeUser.spotifyConnected → drive per-user Spotify widget
 */
const POLL_INTERVAL_MS = 5000;

const useActiveUser = () => {
  const [usersState, setUsersState] = useState(() => getUsers());
  const lastProfileIdRef = useRef(null);

  // Re-read from localStorage whenever another component or the phone sync
  // layer fires 'smartMirror:activeUserChanged' or the generic 'storage' event.
  useEffect(() => {
    const refresh = () => setUsersState(getUsers());
    window.addEventListener('smartMirror:activeUserChanged', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('smartMirror:activeUserChanged', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  // Poll backend for the profile the phone app last activated.
  // getMirrorId() is called inside poll() so it picks up the public key
  // once ProfileContext has written it to localStorage (async on mount).
  useEffect(() => {
    const poll = async () => {
      const mirrorId = backendApi.getMirrorId();
      if (!mirrorId) return;
      const profile = await backendApi.getActiveUser(mirrorId);

      // ── No active user (guest / signed out) ───────────────────────────────
      // Clear our active tracking but DO NOT remove enrolled members. Household
      // membership is owned by useFaceEnrollment now; wiping the list here would
      // erase the very profiles face recognition matches against (this was the
      // bug that made other family members read as "unknown").
      if (!profile) {
        lastProfileIdRef.current = null;
        return;
      }

      // ── Active profile returned ───────────────────────────────────────────
      const newId = `phone-${profile.id}`;

      // Already the active user — nothing to do.
      if (profile.id === lastProfileIdRef.current && getUsers().activeUserId === newId) {
        return;
      }
      lastProfileIdRef.current = profile.id;

      // Non-destructive upsert: ensure the active profile is present + current,
      // then switch to it — WITHOUT deleting any sibling household profiles.
      const remoteProfile = {
        id:             newId,
        name:           profile.name,
        source:         'phone',
        gmailConnected: profile.gmailConnected,
        gmailEmail:     profile.gmailEmail || null,
        backendId:      profile.id,
      };
      const { profiles: list } = getUsers();
      const idx = list.findIndex((p) => p.id === newId);
      const nextList =
        idx >= 0
          ? list.map((p) => (p.id === newId ? { ...p, ...remoteProfile } : p))
          : [...list, remoteProfile];
      saveProfiles(nextList);
      setActiveUser(newId);
      setUsersState(getUsers());
      console.log('[useActiveUser] Active user →', remoteProfile.name, '(id:', profile.id, ')');
    };

    poll();
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      console.log('[useActiveUser] Stopping poll loop.');
      clearInterval(intervalId);
    };
  }, []);

  const switchUser = useCallback((userId) => {
    setActiveUser(userId);
    setUsersState(getUsers());
  }, []);

  const activeUser =
    usersState.profiles.find(p => p.id === usersState.activeUserId) ||
    usersState.profiles[0] ||
    null;

  return {
    activeUser,
    allUsers: usersState.profiles,
    activeUserId: usersState.activeUserId,
    switchUser
  };
};

export default useActiveUser;
