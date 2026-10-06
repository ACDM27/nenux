/**
 * ChatGPT OAuth 2.0 + PKCE authentication for Codex API access.
 *
 * This module implements the OAuth flow to obtain ChatGPT access tokens,
 * which can then be used to call the Codex Responses API.
 *
 * Based on TabTin's implementation.
 */
import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { saveCredentials, type ChatGPTCredentials } from "./chatgptCredentialStore.js";

// OAuth configuration (from TabTin's implementation)
const OAUTH_CONFIG = {
  authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
  tokenEndpoint: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: "openid profile email offline_access",
};

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/**
 * Generate random state parameter for CSRF protection.
 */
function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Build the OAuth authorization URL.
 */
export function buildAuthorizationUrl(state: string, challenge: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OAUTH_CONFIG.clientId,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    scope: OAUTH_CONFIG.scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  code: string,
  verifier: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  console.log(`[ChatGPT OAuth] Exchanging code for tokens...`);
  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH_CONFIG.clientId,
      code,
      code_verifier: verifier,
      redirect_uri: OAUTH_CONFIG.redirectUri,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error(`[ChatGPT OAuth] Token exchange failed:`, error);
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = await response.json();
  console.log(`[ChatGPT OAuth] Token exchange successful, expires in: ${data.expires_in}s`);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch(OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CONFIG.clientId,
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Extract account ID from JWT access token.
 */
function extractAccountId(accessToken: string): string {
  try {
    // JWT format: header.payload.signature
    const parts = accessToken.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid JWT format");
    }

    // Decode payload (base64url)
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    );

    // Extract account ID from custom claim
    const accountInfo = payload["https://api.openai.com/auth"];
    if (!accountInfo?.chatgpt_account_id) {
      throw new Error("Account ID not found in token");
    }

    return accountInfo.chatgpt_account_id;
  } catch (error) {
    throw new Error(`Failed to extract account ID: ${error}`);
  }
}

/**
 * Start OAuth flow: opens browser and waits for callback.
 */
export function startOAuthFlow(): Promise<ChatGPTCredentials> {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = generatePKCE();
    const state = generateState();
    const authUrl = buildAuthorizationUrl(state, challenge);

    // Create local HTTP server to receive callback
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost:${(server.address() as any).port}`);

        if (url.pathname !== "/auth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h1>Authentication Failed</h1><p>${error}</p>`);
          server.close();
          reject(new Error(error));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<h1>Invalid callback</h1>");
          server.close();
          reject(new Error("Invalid callback parameters"));
          return;
        }

        // Exchange code for tokens
        const tokens = await exchangeCodeForTokens(code, verifier);
        const accountId = extractAccountId(tokens.accessToken);

        const credentials: ChatGPTCredentials = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accountId,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
        };

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`
          <h1>✅ ChatGPT 登录成功！</h1>
          <p>你可以关闭这个窗口，回到 Termany 继续使用。</p>
          <script>setTimeout(() => window.close(), 2000);</script>
        `);

        server.close();
        resolve(credentials);
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Error</h1><p>${error}</p>`);
        server.close();
        reject(error);
      }
    });

    // Start server on port 1455
    server.listen(1455, "127.0.0.1", () => {
      console.log(`[ChatGPT OAuth] Listening on http://localhost:1455`);
      console.log(`[ChatGPT OAuth] Opening browser for authentication...`);
      console.log(`[ChatGPT OAuth] If browser doesn't open, visit: ${authUrl}`);

      // Open browser - platform-specific
      import("node:child_process").then(({ exec, spawn }) => {
        try {
          if (process.platform === "win32") {
            // Windows: use cmd /c start
            exec(`cmd /c start "" "${authUrl}"`, (error) => {
              if (error) {
                console.error(`[ChatGPT OAuth] Failed to open browser: ${error.message}`);
                console.log(`[ChatGPT OAuth] Please manually open: ${authUrl}`);
              }
            });
          } else if (process.platform === "darwin") {
            exec(`open "${authUrl}"`);
          } else {
            exec(`xdg-open "${authUrl}"`);
          }
        } catch (error) {
          console.error(`[ChatGPT OAuth] Failed to open browser: ${error}`);
          console.log(`[ChatGPT OAuth] Please manually open: ${authUrl}`);
        }
      });
    });

    server.on("error", (error) => {
      reject(new Error(`Failed to start OAuth server: ${error.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out"));
    }, 5 * 60 * 1000);
  });
}

/**
 * Async version: starts OAuth flow in background, returns auth URL immediately.
 * The callback will be handled asynchronously and credentials saved when received.
 */
export async function startOAuthFlowAsync(): Promise<string> {
  const { verifier, challenge } = generatePKCE();
  const state = generateState();
  const authUrl = buildAuthorizationUrl(state, challenge);

  // Start callback server in background
  const server = http.createServer(async (req, res) => {
    console.log(`[ChatGPT OAuth] Received request: ${req.method} ${req.url}`);
    try {
      const url = new URL(req.url!, `http://localhost:${(server.address() as any).port}`);

      if (url.pathname !== "/auth/callback") {
        console.log(`[ChatGPT OAuth] Ignoring request to: ${url.pathname}`);
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      console.log(`[ChatGPT OAuth] Processing callback...`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>Authentication Failed</h1><p>${error}</p><p>Please close this window and try again.</p>`);
        server.close();
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>Invalid callback</h1>");
        server.close();
        return;
      }

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code, verifier);
      const accountId = extractAccountId(tokens.accessToken);

      const credentials: ChatGPTCredentials = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accountId,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
      };

      // Save credentials
      saveCredentials(credentials);

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`
        <h1>✅ ChatGPT 登录成功！</h1>
        <p>你可以关闭这个窗口，回到 Termany 继续使用。</p>
        <script>setTimeout(() => window.close(), 2000);</script>
      `);

      server.close();
      console.log(`[ChatGPT OAuth] Login successful for account: ${accountId}`);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h1>Error</h1><p>${error}</p>`);
      server.close();
      console.error(`[ChatGPT OAuth] Callback error:`, error);
    }
  });

  // Start server on port 1455
  await new Promise<void>((resolve, reject) => {
    server.listen(1455, "127.0.0.1", () => {
      console.log(`[ChatGPT OAuth] Callback server listening on http://localhost:1455`);
      resolve();
    });
    server.on("error", reject);
  });

  // Open browser in background
  import("node:child_process").then(({ exec }) => {
    try {
      if (process.platform === "win32") {
        exec(`cmd /c start "" "${authUrl}"`);
      } else if (process.platform === "darwin") {
        exec(`open "${authUrl}"`);
      } else {
        exec(`xdg-open "${authUrl}"`);
      }
    } catch (error) {
      console.error(`[ChatGPT OAuth] Failed to open browser: ${error}`);
    }
  });

  // Timeout after 5 minutes
  setTimeout(() => {
    server.close();
    console.log(`[ChatGPT OAuth] Callback server timed out`);
  }, 5 * 60 * 1000);

  return authUrl;
}

/**
 * Get valid credentials, refreshing if necessary.
 */
export async function getValidCredentials(
  stored: ChatGPTCredentials | null
): Promise<ChatGPTCredentials | null> {
  if (!stored) return null;

  // Check if token is expired (with 5 minute buffer)
  if (Date.now() >= stored.expiresAt - 5 * 60 * 1000) {
    try {
      const refreshed = await refreshAccessToken(stored.refreshToken);
      const accountId = extractAccountId(refreshed.accessToken);

      return {
        accessToken: refreshed.accessToken,
        refreshToken: stored.refreshToken, // Refresh doesn't change this
        accountId,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
      };
    } catch (error) {
      console.error("[ChatGPT OAuth] Failed to refresh token:", error);
      return null;
    }
  }

  return stored;
}
