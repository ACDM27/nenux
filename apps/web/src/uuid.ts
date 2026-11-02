/**
 * crypto.randomUUID() polyfill
 *
 * randomUUID() 只在安全上下文（HTTPS / localhost）可用。
 * 通过 HTTP + 非 localhost IP 访问时，降级为 crypto.getRandomValues() 手动生成 UUID v4。
 */

export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // fallback: 用 getRandomValues 手动拼 UUID v4（非安全上下文也可用）
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // 设置 version = 4
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // 设置 variant = RFC 4122
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // 极端 fallback：Math.random（不推荐，但不崩溃）
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
