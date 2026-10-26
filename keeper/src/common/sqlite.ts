import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS doves(id INTEGER PRIMARY KEY,market TEXT NOT NULL,publish_ts INTEGER NOT NULL,price TEXT NOT NULL,slot INTEGER NOT NULL,recv_ms INTEGER NOT NULL,connection TEXT NOT NULL,UNIQUE(market,slot,publish_ts,price));
 CREATE INDEX IF NOT EXISTS doves_time ON doves(market,publish_ts,id);
 CREATE TABLE IF NOT EXISTS coverage(id INTEGER PRIMARY KEY,connection TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY,market TEXT NOT NULL,a INTEGER NOT NULL,b INTEGER,reason TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER);
 CREATE TABLE IF NOT EXISTS trades(id TEXT PRIMARY KEY,cursor INTEGER NOT NULL,executed_at INTEGER NOT NULL,kind TEXT NOT NULL,raw TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS trades_time ON trades(executed_at);
 CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,te INTEGER NOT NULL,status TEXT NOT NULL,oid TEXT,row TEXT,window TEXT);
 CREATE TABLE IF NOT EXISTS houses(address TEXT PRIMARY KEY,id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ruin(sig TEXT NOT NULL,event_index INTEGER NOT NULL,end_slot INTEGER NOT NULL,row TEXT NOT NULL,PRIMARY KEY(sig,event_index));
 CREATE TABLE IF NOT EXISTS refunds(sig TEXT NOT NULL,event_index INTEGER NOT NULL,slot INTEGER NOT NULL,row TEXT NOT NULL,PRIMARY KEY(sig,event_index));
 CREATE TABLE IF NOT EXISTS doves_arrivals(doves_id INTEGER PRIMARY KEY,inserted_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS transactions(sig TEXT PRIMARY KEY,slot INTEGER NOT NULL,raw TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,started_ms INTEGER NOT NULL,ended_ms INTEGER);
 `);
  }
  get(key: string) {
    return (this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as any)
      ?.value as string | undefined;
  }
  set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  close() {
    this.db.close();
  }
}
