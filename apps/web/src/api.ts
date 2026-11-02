/** 远程部署时自动从当前页面 hostname 推导 WebSocket URL */
function defaultWsUrl(): string {
  if (typeof window !== "undefined" && window.location) {
    const { hostname, port, protocol } = window.location;
    const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
    if (!isLocal) {
      const wsProto = protocol === "https:" ? "wss:" : "ws:";
      const portSuffix = port ? `:${port}` : "";
      return `${wsProto}//${hostname}${portSuffix}`;
    }
  }
  return "ws://localhost:5174";
}

export function wsUrl(path = ""): string {
  const base = import.meta.env?.VITE_PTY_URL || defaultWsUrl();
  const stripped = base.replace(/\/+$/, "");
  return path ? `${stripped}${path}` : stripped;
}

export function apiUrl(): string {
  const configured = import.meta.env?.VITE_API_URL || import.meta.env?.VITE_PTY_URL || defaultWsUrl();
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`;
  const normalized = withScheme
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
  return normalized || "http://localhost:5174";
}

export function apiPath(path: string): string {
  return `${apiUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
