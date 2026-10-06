/**
 * Simple credential storage for ChatGPT OAuth tokens.
 *
 * Stores credentials in a JSON file in the user's config directory.
 * For production, consider using system keychain (keytar).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatGPTCredentials } from "./chatgptOAuth.js";

const CONFIG_DIR = path.join(os.homedir(), ".termany");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "chatgpt-credentials.json");

/**
 * Ensure config directory exists.
 */
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

/**
 * Save credentials to disk.
 */
export function saveCredentials(credentials: ChatGPTCredentials): void {
  console.log(`[ChatGPT Credentials] Saving credentials for account: ${credentials.accountId}`);
  try {
    ensureConfigDir();
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), {
      mode: 0o600, // Readable only by owner
    });
    console.log(`[ChatGPT Credentials] Credentials saved to: ${CREDENTIALS_FILE}`);
  } catch (error) {
    console.error(`[ChatGPT Credentials] Failed to save credentials:`, error);
    throw error;
  }
}

/**
 * Load credentials from disk.
 */
export function loadCredentials(): ChatGPTCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    const data = fs.readFileSync(CREDENTIALS_FILE, "utf8");
    return JSON.parse(data) as ChatGPTCredentials;
  } catch (error) {
    console.error("[ChatGPT Credentials] Failed to load:", error);
    return null;
  }
}

/**
 * Clear stored credentials (logout).
 */
export function clearCredentials(): void {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
  } catch (error) {
    console.error("[ChatGPT Credentials] Failed to clear:", error);
  }
}

/**
 * Check if credentials exist.
 */
export function hasCredentials(): boolean {
  return fs.existsSync(CREDENTIALS_FILE);
}
