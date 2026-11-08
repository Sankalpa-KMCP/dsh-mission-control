import { DatabaseSync } from 'node:sqlite';
import { MIGRATION_V1_SQL } from './schema.ts';

export interface Migration {
  readonly version: number;
  readonly up: (db: DatabaseSync) => void;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    up: (db: DatabaseSync) => {
      db.exec(MIGRATION_V1_SQL);
    },
  },
  {
    // v2: Tasks gain verifiable acceptance criteria used by the independent
    // verification gate and surfaced in the Mission Control dashboard.
    version: 2,
    up: (db: DatabaseSync) => {
      db.exec('ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT;');
    },
  },
]);

export function runMigrations(db: DatabaseSync): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC;').all() as unknown as { version: number }[];
  const appliedVersions = new Set(rows.map(r => r.version));

  let appliedCount = 0;
  for (const migration of MIGRATIONS) {
    if (!appliedVersions.has(migration.version)) {
      db.exec('BEGIN IMMEDIATE TRANSACTION;');
      try {
        migration.up(db);
        const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);');
        insert.run(migration.version, new Date().toISOString());
        db.exec('COMMIT;');
        appliedCount++;
      } catch (err) {
        db.exec('ROLLBACK;');
        throw new Error(`Migration v${migration.version} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return appliedCount;
}
