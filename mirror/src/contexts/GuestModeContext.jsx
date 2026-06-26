import { createContext, useContext, useState } from 'react';

const Ctx = createContext({ guestMode: false, enterGuest: () => {}, exitGuest: () => {} });

export function GuestModeProvider({ children }) {
  const [guestMode, setGuestMode] = useState(
    () => localStorage.getItem('sm_guest_mode') !== 'false'
  );

  const enterGuest = () => {
    localStorage.setItem('sm_guest_mode', 'true');
    setGuestMode(true);
  };

  const exitGuest = () => {
    localStorage.setItem('sm_guest_mode', 'false');
    setGuestMode(false);
  };

  return <Ctx.Provider value={{ guestMode, enterGuest, exitGuest }}>{children}</Ctx.Provider>;
}

export const useGuestMode = () => useContext(Ctx);
