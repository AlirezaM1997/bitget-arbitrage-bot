import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openNativeDatabase } from "@/lib/db/native-sqlite";

const files: string[] = [];

afterEach(() => {
  for (const filename of files.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.rmSync(`${filename}${suffix}`, { force: true }); } catch { /* closed on the next run */ }
    }
  }
});

test("native WAL keeps concurrent process writes without lost updates", async () => {
  const filename = path.join(os.tmpdir(), `bitget-wal-${process.pid}-${Date.now()}.sqlite`);
  files.push(filename);
  const db = await openNativeDatabase(filename);
  db.run("CREATE TABLE writes (worker INTEGER NOT NULL, sequence INTEGER NOT NULL, UNIQUE(worker, sequence))");

  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout = 10000');
    db.pragma('journal_mode = WAL');
    const insert = db.prepare('INSERT INTO writes(worker, sequence) VALUES (?, ?)');
    const write = db.transaction((worker) => { for (let i = 0; i < 100; i++) insert.run(worker, i); });
    write(Number(process.argv[2]));
    db.close();
  `;
  try {
    await Promise.all([0, 1, 2, 3].map(worker => child("node", ["-e", script, filename, String(worker)])));
    expect(Number(db.exec("SELECT COUNT(*) AS count FROM writes")[0]?.values[0]?.[0])).toBe(400);
    expect(String(db.exec("PRAGMA journal_mode")[0]?.values[0]?.[0]).toLowerCase()).toBe("wal");
  } finally {
    db.close();
  }
});

function child(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    process.stderr.on("data", chunk => { stderr += String(chunk); });
    process.on("error", reject);
    process.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}
