import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type { ImAttachment } from "@termany/core";
import type { ImService } from "./imService.js";

export const IM_ATTACHMENT_LIMIT = 10 * 1024 * 1024;
const allowed: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".txt": "text/plain", ".md": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export class ImAttachmentService {
  constructor(private db: DatabaseSync, private im: ImService, private directory: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS im_attachment (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, uploader_id TEXT NOT NULL,
      name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }
  authorize(conversationId: string, userId: string) {
    if (!this.im.isMember(conversationId, userId)) throw new Error("not a member of this conversation");
  }
  get(id: string, userId: string): ImAttachment {
    const file = this.db.prepare(`SELECT id, conversation_id AS conversationId, name, size, mime_type AS mimeType
      FROM im_attachment WHERE id=?`).get(id) as unknown as ImAttachment | undefined;
    if (!file) throw new Error("attachment not found");
    this.authorize(file.conversationId, userId);
    return file;
  }
  filePath(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid attachment ID");
    return path.join(this.directory, id);
  }
  async upload(conversationId: string, userId: string, filename: string, contents: Buffer): Promise<ImAttachment> {
    this.authorize(conversationId, userId);
    if (!contents.length || contents.length > IM_ATTACHMENT_LIMIT) throw new Error("attachment must be 1 byte–10 MB");
    const name = filename.replace(/\\/g, "/").split("/").at(-1)!.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
    const extension = path.extname(name).toLowerCase();
    const mimeType = allowed[extension];
    if (!mimeType) throw new Error("unsupported attachment type");
    const hex = contents.subarray(0, 16).toString("hex");
    const valid = mimeType === "image/png" ? hex.startsWith("89504e470d0a1a0a")
      : mimeType === "image/jpeg" ? hex.startsWith("ffd8ff")
      : mimeType === "image/gif" ? /^GIF8[79]a/.test(contents.subarray(0, 6).toString())
      : mimeType === "image/webp" ? contents.subarray(0, 4).toString() === "RIFF" && contents.subarray(8, 12).toString() === "WEBP"
      : mimeType === "application/pdf" ? contents.subarray(0, 5).toString() === "%PDF-"
      : /\.([dxp].*x)$/.test(extension) ? hex.startsWith("504b0304")
      : !contents.includes(0);
    if (!valid) throw new Error("attachment content does not match its file type");
    const file: ImAttachment = { id: randomUUID(), conversationId, name, size: contents.length, mimeType };
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(this.filePath(file.id), contents, { flag: "wx" });
    try {
      this.authorize(conversationId, userId);
      this.db.prepare("INSERT INTO im_attachment VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(file.id, conversationId, userId, name, file.size, mimeType, Date.now());
    } catch (error) { await fs.unlink(this.filePath(file.id)); throw error; }
    return file;
  }
  resolve(ids: unknown, conversationId: string, userId: string): ImAttachment[] {
    if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== "string")) throw new Error("invalid attachment list (maximum 8)");
    return [...new Set(ids)].map(id => {
      const file = this.get(id, userId);
      if (file.conversationId !== conversationId) throw new Error("attachment belongs to another conversation");
      return file;
    });
  }
  async read(file: ImAttachment): Promise<Buffer> { return fs.readFile(this.filePath(file.id)); }
}
