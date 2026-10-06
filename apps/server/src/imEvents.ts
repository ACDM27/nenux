/**
 * IM WebSocket 事件广播器
 *
 * 将 Outbox 投递的事件广播到订阅了对应 channel 的 WebSocket 连接。
 * 支持两种订阅模式：
 * 1. conversation:{id} — 会话内所有成员收到事件
 * 2. personal:{userId} — 用户私有频道（未读更新、新会话通知等）
 */

import type { WebSocket } from "ws";

/** 客户端订阅的频道（连接级别的内存状态） */
export interface ClientSubscriptions {
  /** 连接 ID → 订阅的 channel 集合 */
  subscriptions: Map<string, Set<string>>;
  /** 连接 ID → userId（用于 personal channel 鉴权） */
  userIds: Map<string, string>;
  /** 连接 ID → WebSocket 对象（直接引用，不靠 index 猜） */
  sockets: Map<string, WebSocket>;
}

/** 创建订阅管理器 */
export function createSubscriptionManager(): ClientSubscriptions {
  return {
    subscriptions: new Map(),
    userIds: new Map(),
    sockets: new Map(),
  };
}

/** 注册连接 */
export function registerConnection(
  subs: ClientSubscriptions,
  connId: string,
  userId: string,
  ws: WebSocket
): void {
  subs.userIds.set(connId, userId);
  subs.sockets.set(connId, ws);
  if (!subs.subscriptions.has(connId)) {
    subs.subscriptions.set(connId, new Set());
  }
  subs.subscriptions.get(connId)!.add(`personal:${userId}`);
}

/** 移除连接 */
export function unregisterConnection(subs: ClientSubscriptions, connId: string): void {
  subs.subscriptions.delete(connId);
  subs.userIds.delete(connId);
  subs.sockets.delete(connId);
}

/** 订阅频道 */
export function subscribe(subs: ClientSubscriptions, connId: string, channel: string): void {
  if (!subs.subscriptions.has(connId)) {
    subs.subscriptions.set(connId, new Set());
  }
  subs.subscriptions.get(connId)!.add(channel);
}

/** 取消订阅 */
export function unsubscribe(subs: ClientSubscriptions, connId: string, channel: string): void {
  subs.subscriptions.get(connId)?.delete(channel);
}

/**
 * 广播事件到指定 channel 的所有订阅者
 */
export function broadcastToChannel(
  subs: ClientSubscriptions,
  channel: string,
  eventType: string,
  data: unknown
): number {
  const event = JSON.stringify({ type: eventType, channel, data });
  let delivered = 0;

  console.log(`[IM] 📡 Broadcasting ${eventType} to ${channel}, subscribers:`,
    Array.from(subs.subscriptions.entries()).map(([id, channels]) => ({id, channels: [...channels]})));

  for (const [connId, channels] of subs.subscriptions) {
    if (!channels.has(channel)) {
      console.log(`[IM]   ⏭️  Client ${connId} not subscribed to ${channel}`);
      continue;
    }

    const ws = subs.sockets.get(connId);
    console.log(`[IM]   📤 Sending to client ${connId}, ws exists: ${!!ws}, readyState: ${ws?.readyState}`);
    if (ws && ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(event);
      delivered++;
      console.log(`[IM]   ✅ Delivered to client ${connId}`);
    }
  }

  console.log(`[IM] 📡 Broadcast complete, delivered to ${delivered} clients`);
  return delivered;
}

/**
 * 创建 Outbox deliver 回调
 */
export function createOutboxDeliver(
  subs: ClientSubscriptions
): (channel: string, eventType: string, payload: string) => Promise<void> {
  return async (channel, eventType, payload) => {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      data = payload;
    }
    broadcastToChannel(subs, channel, eventType, data);
  };
}

/**
 * WebSocket 消息处理器
 */
export function handleClientMessage(
  subs: ClientSubscriptions,
  connId: string,
  raw: string
): void {
  let msg: { type: string; channel?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const channel = msg.channel;
  if (!channel) return;

  // 鉴权
  const userId = subs.userIds.get(connId);
  if (channel.startsWith("personal:") && channel !== `personal:${userId}`) {
    return;
  }

  switch (msg.type) {
    case "subscribe":
      subscribe(subs, connId, channel);
      break;
    case "unsubscribe":
      unsubscribe(subs, connId, channel);
      break;
    case "typing":
      broadcastToChannel(subs, channel, "im.typing", { userId });
      break;
  }
}
