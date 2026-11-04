import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface StoredEvent {
  sequence: number;
  conversationId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface Conversation { id: string; title: string; updatedAt: string }
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export class BridgeStore {
  readonly database: Database.Database;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (code_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id), type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_conversation_sequence ON events(conversation_id, sequence);
    `);
  }

  createPairingCode(ttlMs = 300_000): string {
    const code = randomBytes(8).toString("hex").toUpperCase();
    this.database.prepare("INSERT INTO pairing_codes VALUES (?, ?, NULL)").run(sha256(code), Date.now() + ttlMs);
    return code;
  }

  pair(code: string, deviceName: string): { deviceId: string; token: string } | undefined {
    return this.database.transaction(() => {
      const result = this.database.prepare(
        "UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?"
      ).run(Date.now(), sha256(code), Date.now());
      if (result.changes !== 1) return undefined;
      const deviceId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      this.database.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, NULL)")
        .run(deviceId, deviceName.slice(0, 80), sha256(token), new Date().toISOString());
      return { deviceId, token };
    })();
  }

  authenticate(token: string): string | undefined {
    return (this.database.prepare("SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(sha256(token)) as { id: string } | undefined)?.id;
  }

  deviceIsActive(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL").get(id));
  }

  revokeDevice(id: string): boolean {
    return this.database.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(new Date().toISOString(), id).changes === 1;
  }

  listDevices(): Array<{ id: string; name: string; createdAt: string; revokedAt: string | null }> {
    return this.database.prepare("SELECT id, name, created_at AS createdAt, revoked_at AS revokedAt FROM devices ORDER BY created_at")
      .all() as Array<{ id: string; name: string; createdAt: string; revokedAt: string | null }>;
  }

  createConversation(): Conversation {
    return this.database.transaction(() => {
      const conversation = { id: randomUUID(), title: "Live VS Code", updatedAt: new Date().toISOString() };
      this.database.prepare("INSERT INTO conversations VALUES (?, ?, ?)").run(conversation.id, conversation.title, conversation.updatedAt);
      return conversation;
    })();
  }

  listConversations(): Conversation[] {
    return this.database.prepare("SELECT id, title, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC").all() as Conversation[];
  }

  getConversation(id: string): Conversation | undefined {
    return this.database.prepare("SELECT id, title, updated_at AS updatedAt FROM conversations WHERE id = ?").get(id) as Conversation | undefined;
  }

  deleteConversation(id: string): boolean {
    return this.database.transaction(() => {
      this.database.prepare("DELETE FROM events WHERE conversation_id = ?").run(id);
      return this.database.prepare("DELETE FROM conversations WHERE id = ?").run(id).changes === 1;
    })();
  }

  appendEvent(conversationId: string, type: string, payload: Record<string, unknown>): StoredEvent {
    return this.database.transaction(() => {
      const createdAt = new Date().toISOString();
      const result = this.database.prepare("INSERT INTO events(conversation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(conversationId, type, JSON.stringify(payload), createdAt);
      this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(createdAt, conversationId);
      return { sequence: Number(result.lastInsertRowid), conversationId, type, payload, createdAt };
    })();
  }

  listEvents(conversationId: string, after: number): StoredEvent[] {
    return (this.database.prepare(`SELECT sequence, conversation_id AS conversationId, type,
      payload_json AS payloadJson, created_at AS createdAt FROM events WHERE conversation_id = ? AND sequence > ?
      ORDER BY sequence LIMIT 500`).all(conversationId, after) as Array<Omit<StoredEvent, "payload"> & { payloadJson: string }>)
      .map(({ payloadJson, ...event }) => ({ ...event, payload: JSON.parse(payloadJson) as Record<string, unknown> }));
  }

  close(): void { this.database.close(); }
}
