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

      const { profiles: currentProfiles } = getUsers();
      const phoneProfiles = currentProfiles.filter(p => p.source === 'phone');
      const localProfiles = currentProfiles.filter(p => p.source !== 'phone');

      // ── Case 1: no active user (deleted or never set) ──────────────────────
      if (!profile) {
        if (phoneProfiles.length === 0) return; // nothing to remove

        console.log('[useActiveUser] Profile removed on backend — clearing:', phoneProfiles.map(p => p.name));
        // saveProfiles replaces the full list; if activeUserId was a phone
        // profile it automatically falls back to the first local profile or null.
        saveProfiles(localProfiles);
        lastProfileIdRef.current = null;
        setUsersState(getUsers());
        console.log('[useActiveUser] Active user cleared.');
        return;
      }

      // ── Case 2: active profile returned ────────────────────────────────────
      const newId = `phone-${profile.id}`;

      // Detect stale phone profiles (previously set users now absent from backend).
      const stale = phoneProfiles.filter(p => p.id !== newId);
      if (stale.length > 0) {
        console.log('[useActiveUser] Removing stale phone profiles:', stale.map(p => p.name));
      }

      // Skip only when the same profile is active AND the list is already clean.
      const alreadyClean = phoneProfiles.length === 1 && phoneProfiles[0].id === newId;
      if (profile.id === lastProfileIdRef.current && alreadyClean) {
        console.log('[useActiveUser] Profile unchanged and clean (id:', profile.id, ') — skipping.');
        return;
      }

      console.log('[useActiveUser] Updating to profile:', profile.name, '(id:', profile.id, ')');
      lastProfileIdRef.current = profile.id;

      const remoteProfile = {
        id:           newId,
        name:         profile.name,
        source:       'phone',
        gmailConnected: profile.gmailConnected,
        gmailEmail:   profile.gmailEmail || null,
        backendId:    profile.id,
      };

      // Replace ALL phone profiles with only the current one.
      // This removes deleted/switched users without touching local profiles.
      saveProfiles([...localProfiles, remoteProfile]);
      setActiveUser(remoteProfile.id);
      setUsersState(getUsers());
      console.log('[useActiveUser] UI active user updated to:', remoteProfile.name);
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
