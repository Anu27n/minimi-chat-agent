import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Conversation, Exchange, SearchRecord, Source } from "../core/types.js";

/**
 * Persistent memory: every finished question/answer pair, timestamped, in SQLite.
 *
 * The unit of memory is the *exchange* (one user question + the final answer +
 * the sources behind it), not individual chat messages. That is the granularity
 * users ask about ("what did I ask you on 3 November, is your answer still right?")
 * and it keeps the sources that justified an answer next to the answer itself.
 *
 * Retrieval is two indexes over the same rows:
 *   - a B-tree on asked_at for "when" questions (date ranges), and
 *   - an FTS5 (BM25) index on question+answer for "what about" questions.
 */

const SCHEMA_VERSION = 1;

type Row = Record<string, SQLInputValue>;

export class MemoryStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    const { user_version } = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (user_version >= SCHEMA_VERSION) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exchanges (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        asked_at        INTEGER NOT NULL,   -- epoch ms, when the user sent the question
        answered_at     INTEGER NOT NULL,
        question        TEXT NOT NULL,
        answer          TEXT NOT NULL,
        sources_json    TEXT NOT NULL,      -- Source[] the answer cites
        searches_json   TEXT NOT NULL,      -- SearchRecord[] the agent ran
        model           TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS exchanges_asked_at ON exchanges(asked_at);
      CREATE INDEX IF NOT EXISTS exchanges_conversation ON exchanges(conversation_id, asked_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
        question, answer, content='exchanges', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS exchanges_ai AFTER INSERT ON exchanges BEGIN
        INSERT INTO exchanges_fts(rowid, question, answer) VALUES (new.id, new.question, new.answer);
      END;
      CREATE TRIGGER IF NOT EXISTS exchanges_ad AFTER DELETE ON exchanges BEGIN
        INSERT INTO exchanges_fts(exchanges_fts, rowid, question, answer) VALUES ('delete', old.id, old.question, old.answer);
      END;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  }

  close(): void {
    this.db.close();
  }

  // ── conversations ───────────────────────────────────────────────────

  createConversation(title: string, at: Date, id: string = randomUUID()): Conversation {
    const t = at.getTime();
    this.db
      .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, title, t, t);
    return { id, title, createdAt: at, updatedAt: at };
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Row | undefined;
    return row ? toConversation(row) : undefined;
  }

  listConversations(limit = 50): Conversation[] {
    const rows = this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(toConversation);
  }

  // ── exchanges ───────────────────────────────────────────────────────

  addExchange(e: Omit<Exchange, "id"> & { answeredAt: Date }): Exchange {
    const result = this.db
      .prepare(
        `INSERT INTO exchanges (conversation_id, asked_at, answered_at, question, answer, sources_json, searches_json, model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.conversationId,
        e.askedAt.getTime(),
        e.answeredAt.getTime(),
        e.question,
        e.answer,
        JSON.stringify(e.sources),
        JSON.stringify(e.searches),
        e.model,
      );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(e.answeredAt.getTime(), e.conversationId);
    const { answeredAt: _answeredAt, ...rest } = e;
    return { ...rest, id: Number(result.lastInsertRowid) };
  }

  /** The last `limit` exchanges of a conversation, oldest first. */
  recentExchanges(conversationId: string, limit: number): Exchange[] {
    const rows = this.db
      .prepare("SELECT * FROM exchanges WHERE conversation_id = ? ORDER BY asked_at DESC, id DESC LIMIT ?")
      .all(conversationId, limit) as Row[];
    return rows.map(toExchange).reverse();
  }

  /**
   * Exchanges asked within [start, end), across all conversations.
   * When `terms` are given, the ones that also match the topic come first.
   */
  exchangesBetween(start: Date, end: Date, opts: { terms?: string[]; limit?: number } = {}): Exchange[] {
    const limit = opts.limit ?? 10;
    const match = toMatchExpression(opts.terms ?? []);
    if (!match) {
      const rows = this.db
        .prepare("SELECT * FROM exchanges WHERE asked_at >= ? AND asked_at < ? ORDER BY asked_at ASC LIMIT ?")
        .all(start.getTime(), end.getTime(), limit) as Row[];
      return rows.map(toExchange);
    }
    const rows = this.db
      .prepare(
        `SELECT e.* FROM exchanges e
         LEFT JOIN (SELECT rowid, bm25(exchanges_fts) AS score FROM exchanges_fts WHERE exchanges_fts MATCH ?) f
           ON f.rowid = e.id
         WHERE e.asked_at >= ? AND e.asked_at < ?
         ORDER BY (f.score IS NULL), f.score, e.asked_at ASC
         LIMIT ?`,
      )
      .all(match, start.getTime(), end.getTime(), limit) as Row[];
    return rows.map(toExchange);
  }

  /** Topic search over all past exchanges (BM25, best first). */
  searchExchanges(terms: string[], opts: { limit?: number; before?: Date } = {}): Exchange[] {
    const match = toMatchExpression(terms);
    if (!match) return [];
    const rows = this.db
      .prepare(
        `SELECT e.* FROM exchanges_fts f JOIN exchanges e ON e.id = f.rowid
         WHERE exchanges_fts MATCH ? AND e.asked_at < ?
         ORDER BY bm25(exchanges_fts) LIMIT ?`,
      )
      .all(match, (opts.before ?? new Date(8.64e15)).getTime(), opts.limit ?? 5) as Row[];
    return rows.map(toExchange);
  }
}

/** Quote every term so user text can never inject FTS5 query syntax. */
function toMatchExpression(terms: string[]): string | undefined {
  const quoted = terms.filter((t) => t.trim()).map((t) => `"${t.replaceAll('"', '""')}"`);
  return quoted.length ? quoted.join(" OR ") : undefined;
}

function toConversation(r: Row): Conversation {
  return {
    id: String(r.id),
    title: String(r.title),
    createdAt: new Date(Number(r.created_at)),
    updatedAt: new Date(Number(r.updated_at)),
  };
}

function toExchange(r: Row): Exchange {
  return {
    id: Number(r.id),
    conversationId: String(r.conversation_id),
    askedAt: new Date(Number(r.asked_at)),
    question: String(r.question),
    answer: String(r.answer),
    sources: JSON.parse(String(r.sources_json)) as Source[],
    searches: JSON.parse(String(r.searches_json)) as SearchRecord[],
    model: String(r.model),
  };
}
