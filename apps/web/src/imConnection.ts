export interface ImSocket {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Replay desired subscriptions, never stale ephemeral events. */
export function createImConnection(options: {
  socket: () => ImSocket;
  connected: (connected: boolean) => void;
  event: (type: string, data: unknown) => void;
  resync: () => void;
  retryMs?: number;
}) {
  const channels = new Set<string>();
  let socket: ImSocket | undefined;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const send = (data: unknown) => {
    if (!disposed && socket?.readyState === 1) socket.send(JSON.stringify(data));
  };
  const connect = () => {
    if (disposed) return;
    const current = options.socket();
    socket = current;
    current.onopen = () => {
      if (disposed || socket !== current) return;
      channels.forEach(channel => send({ type: "subscribe", channel }));
      options.connected(true);
      options.resync();
    };
    current.onmessage = event => {
      if (disposed || socket !== current) return;
      try {
        const message = JSON.parse(event.data);
        if (typeof message.type === "string" && message.type.startsWith("im.")) {
          options.event(message.type, message.data ?? message);
        }
      } catch { /* Ignore non-JSON transport messages. */ }
    };
    current.onclose = () => {
      if (disposed || socket !== current) return;
      options.connected(false);
      clearTimeout(retry);
      retry = setTimeout(connect, options.retryMs ?? 5000);
    };
    current.onerror = () => current.close();
  };
  connect();
  return {
    subscribe(channel: string) {
      if (channels.has(channel)) return;
      channels.add(channel);
      send({ type: "subscribe", channel });
    },
    unsubscribe(channel: string) {
      if (channels.delete(channel)) send({ type: "unsubscribe", channel });
    },
    typing(channel: string) { send({ type: "typing", channel }); },
    dispose() {
      disposed = true;
      clearTimeout(retry);
      if (socket) {
        socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
        socket.close();
      }
      options.connected(false);
    },
  };
}
