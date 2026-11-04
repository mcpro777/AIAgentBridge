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

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

export interface StoredApproval {
  id: string;
  conversationId: string;
  operation: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
  expiresAt: number;
}

export interface StoredQuestion {
  id: string;
  conversationId: string;
  prompt: string;
  choices: string[] | null;
  allowFreeform: boolean;
  status: "pending" | "answered" | "expired";
  answer: string | null;
  expiresAt: number;
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export class BridgeStore {
  readonly database: Database.Database;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new Database(filename);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_conversation_sequence ON events(conversation_id, sequence);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        operation_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        prompt TEXT NOT NULL,
        choices_json TEXT,
        allow_freeform INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'expired')),
        answer TEXT,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const questionColumns = this.database.pragma("table_info(questions)") as Array<{ name: string }>;
    if (!questionColumns.some(({ name }) => name === "allow_freeform")) {
      this.database.exec("ALTER TABLE questions ADD COLUMN allow_freeform INTEGER NOT NULL DEFAULT 1");
    }
  }

  createPairingCode(ttlMs = 5 * 60_000): string {
    let code: string;
    do {
      code = randomBytes(8).toString("hex").toUpperCase();
    } while (this.database.prepare("SELECT 1 FROM pairing_codes WHERE code_hash = ?").get(sha256(code)));
    this.database.prepare("INSERT INTO pairing_codes(code_hash, expires_at) VALUES (?, ?)").run(sha256(code), Date.now() + ttlMs);
    return code;
  }

  pair(code: string, deviceName: string): { deviceId: string; token: string } | undefined {
    const token = randomBytes(32).toString("base64url");
    const deviceId = randomUUID();
    const now = Date.now();
    const pairTransaction = this.database.transaction(() => {
      const row = this.database.prepare(
        "SELECT code_hash FROM pairing_codes WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?"
      ).get(sha256(code), now) as { code_hash: string } | undefined;
      if (!row) return false;
      const update = this.database.prepare(
        "UPDATE pairing_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?"
      ).run(now, row.code_hash, now);
      if (update.changes !== 1) return false;
      this.database.prepare("INSERT INTO devices(id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(
        deviceId,
        deviceName.slice(0, 80),
        sha256(token),
        new Date(now).toISOString()
      );
      return true;
    });
    return pairTransaction() ? { deviceId, token } : undefined;
  }

  authenticate(token: string): string | undefined {
    const row = this.database.prepare(
      "SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL"
    ).get(sha256(token)) as { id: string } | undefined;
    return row?.id;
  }

  deviceIsActive(deviceId: string): boolean {
    const row = this.database.prepare("SELECT 1 AS active FROM devices WHERE id = ? AND revoked_at IS NULL").get(deviceId);
    return Boolean(row);
  }

  revokeDevice(deviceId: string): boolean {
    const result = this.database.prepare(
      "UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
    ).run(new Date().toISOString(), deviceId);
    return result.changes === 1;
  }

  listDevices(): Array<{ id: string; name: string; createdAt: string; revokedAt: string | null }> {
    return this.database.prepare(
      "SELECT id, name, created_at AS createdAt, revoked_at AS revokedAt FROM devices ORDER BY created_at"
    ).all() as Array<{ id: string; name: string; createdAt: string; revokedAt: string | null }>;
  }

  createConversation(title = "New conversation"): Conversation {
    const id = randomUUID();
    const updatedAt = new Date().toISOString();
    this.database.prepare(
      "INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(id, title.slice(0, 120), updatedAt, updatedAt);
    return { id, title: title.slice(0, 120), updatedAt };
  }

  listConversations(): Conversation[] {
    return this.database.prepare(
      "SELECT id, title, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC"
    ).all() as Conversation[];
  }

  getConversation(id: string): (Conversation & { sessionId: string | null }) | undefined {
    return this.database.prepare(
      "SELECT id, title, updated_at AS updatedAt, session_id AS sessionId FROM conversations WHERE id = ?"
    ).get(id) as (Conversation & { sessionId: string | null }) | undefined;
  }

  setSessionId(conversationId: string, sessionId: string): void {
    this.database.prepare("UPDATE conversations SET session_id = ? WHERE id = ?").run(sessionId, conversationId);
  }

  updateConversationTitle(conversationId: string, title: string): void {
    this.database.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(
      title.slice(0, 120),
      new Date().toISOString(),
      conversationId
    );
  }

  deleteConversation(conversationId: string): boolean {
    const transaction = this.database.transaction(() => {
      if (!this.getConversation(conversationId)) return false;
      this.database.prepare("DELETE FROM events WHERE conversation_id = ?").run(conversationId);
      this.database.prepare("DELETE FROM approvals WHERE conversation_id = ?").run(conversationId);
      this.database.prepare("DELETE FROM questions WHERE conversation_id = ?").run(conversationId);
      return this.database.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId).changes === 1;
    });
    return transaction();
  }

  appendEvent(conversationId: string, type: string, payload: Record<string, unknown>): StoredEvent {
    const createdAt = new Date().toISOString();
    const result = this.database.prepare(
      "INSERT INTO events(conversation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(conversationId, type, JSON.stringify(payload), createdAt);
    this.database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(createdAt, conversationId);
    return { sequence: Number(result.lastInsertRowid), conversationId, type, payload, createdAt };
  }

  listEvents(conversationId: string, after: number, limit = 500): StoredEvent[] {
    return (this.database.prepare(
      `SELECT sequence, conversation_id AS conversationId, type, payload_json AS payloadJson, created_at AS createdAt
       FROM events WHERE conversation_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`
    ).all(conversationId, after, limit) as Array<{ sequence: number; conversationId: string; type: string; payloadJson: string; createdAt: string }>)
      .map(({ payloadJson, ...event }) => ({ ...event, payload: JSON.parse(payloadJson) as Record<string, unknown> }));
  }

  createApproval(conversationId: string, operation: Record<string, unknown>, ttlMs: number): StoredApproval {
    const id = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.database.prepare(
      "INSERT INTO approvals(id, conversation_id, operation_json, status, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)"
    ).run(id, conversationId, JSON.stringify(operation), new Date().toISOString(), expiresAt);
    return { id, conversationId, operation, status: "pending", expiresAt };
  }

  resolveApproval(id: string, approved: boolean): boolean {
    const result = this.database.prepare(
      "UPDATE approvals SET status = ? WHERE id = ? AND status = 'pending' AND expires_at > ?"
    ).run(approved ? "approved" : "denied", id, Date.now());
    return result.changes === 1;
  }

  expireApproval(id: string): void {
    this.database.prepare(
      "UPDATE approvals SET status = 'denied' WHERE id = ? AND status = 'pending'"
    ).run(id);
  }

  createQuestion(
    conversationId: string,
    prompt: string,
    choices: string[] | undefined,
    allowFreeform: boolean,
    ttlMs: number
  ): StoredQuestion {
    const id = randomUUID();
    const expiresAt = Date.now() + ttlMs;
    this.database.prepare(
      "INSERT INTO questions(id, conversation_id, prompt, choices_json, allow_freeform, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    ).run(id, conversationId, prompt, choices ? JSON.stringify(choices) : null, Number(allowFreeform), new Date().toISOString(), expiresAt);
    return { id, conversationId, prompt, choices: choices ?? null, allowFreeform, status: "pending", answer: null, expiresAt };
  }

  resolveQuestion(id: string, answer: string): boolean {
    const transaction = this.database.transaction(() => {
      const question = this.database.prepare(
        "SELECT choices_json AS choicesJson, allow_freeform AS allowFreeform FROM questions WHERE id = ? AND status = 'pending' AND expires_at > ?"
      ).get(id, Date.now()) as { choicesJson: string | null; allowFreeform: number } | undefined;
      if (!question) return false;
      const choices = question.choicesJson ? JSON.parse(question.choicesJson) as string[] : undefined;
      if (question.allowFreeform === 0 && choices && !choices.includes(answer)) return false;
      const result = this.database.prepare(
        "UPDATE questions SET status = 'answered', answer = ? WHERE id = ? AND status = 'pending' AND expires_at > ?"
      ).run(answer, id, Date.now());
      return result.changes === 1;
    });
    return transaction();
  }

  expireQuestion(id: string): void {
    this.database.prepare(
      "UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'"
    ).run(id);
  }

  expirePendingInteractions(): { approvals: Array<{ id: string; conversationId: string }>; questions: Array<{ id: string; conversationId: string }> } {
    const transaction = this.database.transaction(() => {
      const approvals = this.database.prepare(
        "SELECT id, conversation_id AS conversationId FROM approvals WHERE status = 'pending'"
      ).all() as Array<{ id: string; conversationId: string }>;
      const questions = this.database.prepare(
        "SELECT id, conversation_id AS conversationId FROM questions WHERE status = 'pending'"
      ).all() as Array<{ id: string; conversationId: string }>;
      this.database.prepare("UPDATE approvals SET status = 'denied' WHERE status = 'pending'").run();
      this.database.prepare("UPDATE questions SET status = 'expired' WHERE status = 'pending'").run();
      return { approvals, questions };
    });
    return transaction();
  }

  close(): void {
    this.database.close();
  }
}
