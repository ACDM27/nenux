/**
 * ChatGPT Login component for Termany.
 *
 * Provides OAuth login to access Codex using ChatGPT subscription.
 */
import { useState, useEffect } from "react";
import { apiPath } from "../api";

interface ChatGPTStatus {
  loggedIn: boolean;
}

export function ChatGPTLogin({ onLoginSuccess }: { onLoginSuccess?: () => void }) {
  const [status, setStatus] = useState<ChatGPTStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check login status on mount
    fetch(apiPath("/api/chatgpt/status"))
      .then((res) => res.json())
      .then(setStatus)
      .catch(() => setStatus({ loggedIn: false }));
  }, []);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(apiPath("/api/chatgpt/login"), { method: "POST" });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Server returned invalid response (HTTP ${res.status})`);
      }

      if (!res.ok) {
        throw new Error(data.error || "Login failed");
      }

      // API returns authUrl, open it in browser
      if (data.authUrl) {
        // Try to open in new window first, fallback to new tab
        const newWindow = window.open(data.authUrl, "_blank", "width=600,height=700");
        if (!newWindow) {
          // Popup blocked, open in new tab
          window.open(data.authUrl, "_blank");
        }
      }

      // Start polling for login status
      const checkLoginStatus = async () => {
        for (let i = 0; i < 60; i++) { // Check for up to 5 minutes
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

          try {
            const statusRes = await fetch(apiPath("/api/chatgpt/status"));
            const statusData = await statusRes.json();

            if (statusData.loggedIn) {
              setStatus({ loggedIn: true });
              onLoginSuccess?.();
              setLoading(false);
              return;
            }
          } catch {
            // Continue polling
          }
        }

        // Timeout
        setError("登录超时，请重试");
        setLoading(false);
      };

      checkLoginStatus();
    } catch (err) {
      setError(String(err));
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(apiPath("/api/chatgpt/logout"), { method: "POST" });
      setStatus({ loggedIn: false });
    } catch (err) {
      setError(String(err));
    }
  };

  if (status === null) {
    return <div className="chatgpt-login">Loading...</div>;
  }

  return (
    <div className="chatgpt-login">
      {status.loggedIn ? (
        <div className="chatgpt-login-logged-in">
          <span className="chatgpt-login-status">✅ 已登录 ChatGPT</span>
          <button
            className="chatgpt-login-btn"
            onClick={handleLogout}
            disabled={loading}
          >
            退出登录
          </button>
        </div>
      ) : (
        <div className="chatgpt-login-prompt">
          <p>使用 ChatGPT 订阅访问 Codex</p>
          <button
            className="chatgpt-login-btn"
            onClick={handleLogin}
            disabled={loading}
          >
            {loading ? "登录中..." : "使用 ChatGPT 登录"}
          </button>
          {error && <p className="chatgpt-login-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
