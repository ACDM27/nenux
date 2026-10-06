/**
 * IM WebSocket Hook
 *
 * 管理 IM 事件的 WebSocket 连接：
 * - 连接时自动发送 subscribe/unsubscribe 消息
 * - 接收 im.* 事件并分发到 imStore
 * - 自动重连（5s 间隔）
 */

import { useEffect, useRef, useCallback } from "react";
import { useImStore } from "./imStore";

const WS_RECONNECT_MS = 5000;

/**
 * 连接到 IM WebSocket 事件通道。
 * 在 App 顶层调用一次即可。
 */
export function useImWebSocket(serverPort: number) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
  const { userId, setWsConnected, handleImEvent } = useImStore();

  // 用 ref 稳定化 store actions，避免 connect 频繁重建
  const actionsRef = useRef({ setWsConnected, handleImEvent });
  actionsRef.current = { setWsConnected, handleImEvent };

  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const serverPortRef = useRef(serverPort);
  serverPortRef.current = serverPort;

  // 待发送的消息队列（WS 未连接时暂存）
  const pendingMessages = useRef<string[]>([]);
  const isConnected = useRef(false);

  useEffect(() => {
    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const wsUrl = `ws://localhost:${serverPortRef.current}?user=${encodeURIComponent(userIdRef.current)}&im=1`;
      console.log("[IM WS] Connecting to:", wsUrl);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("[IM WS] ✅ Connected");
        isConnected.current = true;
        actionsRef.current.setWsConnected(true);

        // 发送排队中的消息
        while (pendingMessages.current.length > 0) {
          const msg = pendingMessages.current.shift()!;
          console.log("[IM WS] 📤 Sending queued:", msg);
          ws.send(msg);
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type?.startsWith("im.")) {
            actionsRef.current.handleImEvent(msg.type, msg.data ?? msg);
          }
        } catch {
          // 非 JSON → 忽略
        }
      };

      ws.onclose = (event) => {
        console.log("[IM WS] 🔌 Disconnected", { code: event.code, reason: event.reason });
        isConnected.current = false;
        actionsRef.current.setWsConnected(false);
        reconnectTimer.current = setTimeout(connect, WS_RECONNECT_MS);
      };

      ws.onerror = (event) => {
        console.log("[IM WS] ❌ Error", event);
        ws.close();
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      isConnected.current = false;
    };
  }, []); // 空依赖 — 只在挂载时连接一次

  /** 发送消息（WS 未连接时排队） */
  const send = useCallback((data: unknown) => {
    const msg = JSON.stringify(data);
    if (isConnected.current && wsRef.current?.readyState === WebSocket.OPEN) {
      console.log("[IM WS] 📤 Sending:", msg);
      wsRef.current.send(msg);
    } else {
      console.log("[IM WS] ⏳ Queueing (not connected):", msg);
      pendingMessages.current.push(msg);
    }
  }, []);

  /** 订阅会话频道 */
  const subscribe = useCallback((channel: string) => {
    send({ type: "subscribe", channel });
  }, [send]);

  /** 取消订阅 */
  const unsubscribe = useCallback((channel: string) => {
    send({ type: "unsubscribe", channel });
  }, [send]);

  /** 发送 typing 状态 */
  const sendTyping = useCallback((channel: string) => {
    send({ type: "typing", channel });
  }, [send]);

  return { subscribe, unsubscribe, sendTyping };
}
