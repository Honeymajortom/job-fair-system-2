import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { connectSocket } from '../api';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

// Connects only once a session is confirmed (lib/io.js rejects anonymous
// sockets outright) and tears down on logout — mirrors AuthContext's
// user-truthy/falsy lifecycle rather than connecting eagerly on mount.
export function SocketProvider({ children }) {
  const { user } = useAuth();
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    if (!user) return undefined;
    const s = connectSocket();
    s.connect();
    setSocket(s);
    return () => { s.disconnect(); setSocket(null); };
  }, [user]);

  function joinDesk({ companyId, deskId }) {
    socket?.emit('join-desk', { companyId, deskId });
  }

  return (
    <SocketContext.Provider value={{ socket, joinDesk }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}

// Subscribes `handler` to `event` for the lifetime of the calling component,
// re-subscribing whenever the underlying socket instance changes (reconnect,
// login/logout). `handler` is captured via a ref so callers can pass an
// inline closure without re-subscribing on every render.
export function useSocketEvent(event, handler) {
  const { socket } = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return undefined;
    const wrapped = (...args) => handlerRef.current(...args);
    socket.on(event, wrapped);
    return () => socket.off(event, wrapped);
  }, [socket, event]);
}
