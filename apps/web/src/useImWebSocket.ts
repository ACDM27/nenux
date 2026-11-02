import { useEffect, useRef, useCallback } from "react";
import { useImStore } from "./imStore";
import { wsUrl } from "./api";
import { createImConnection, type ImSocket } from "./imConnection";

export function useImWebSocket(serverPort: number) {
  const userId = useImStore(s => s.userId);
  const connection = useRef<ReturnType<typeof createImConnection>>();
  const channels = useRef(new Set<string>());

  useEffect(() => {
    const url = new URL(wsUrl());
    if (!import.meta.env?.VITE_PTY_URL && ["localhost", "127.0.0.1"].includes(url.hostname)) {
      url.port = String(serverPort);
    }
    url.searchParams.set("user", userId);
    url.searchParams.set("im", "1");
    const transport = createImConnection({
      socket: () => new WebSocket(url) as unknown as ImSocket,
      connected: value => useImStore.getState().setWsConnected(value),
      event: (type, data) => useImStore.getState().handleImEvent(type, data),
      resync: () => {
        const store = useImStore.getState();
        void store.loadConversations();
        void store.loadUnreadCounts();
        if (store.activeConversationId) void store.loadMessages(store.activeConversationId);
      },
    });
    connection.current = transport;
    channels.current.forEach(channel => transport.subscribe(channel));
    return () => {
      connection.current = undefined;
      transport.dispose();
    };
  }, [userId, serverPort]);

  const subscribe = useCallback((channel: string) => {
    channels.current.add(channel);
    connection.current?.subscribe(channel);
  }, []);
  const unsubscribe = useCallback((channel: string) => {
    channels.current.delete(channel);
    connection.current?.unsubscribe(channel);
  }, []);
  const sendTyping = useCallback((channel: string) => connection.current?.typing(channel), []);
  return { subscribe, unsubscribe, sendTyping };
}
