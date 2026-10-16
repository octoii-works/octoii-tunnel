/** Device records in SQLite, for a relay in one Bun process. */
import { Database } from "bun:sqlite";
import type { DeviceRecord } from "../host.ts";

/** The device records of a relay, in a SQLite file, or in memory with `":memory:"`. */
export class SqliteDevices {
	private readonly database: Database;

	constructor(path: string) {
		this.database = new Database(path, { create: true, strict: true });
		if (path !== ":memory:") this.database.run("PRAGMA journal_mode = WAL");
		this.database.run("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL)");
	}

	/** Creates the device; false when its id is taken. */
	create(record: DeviceRecord): boolean {
		const result = this.database
			.query("INSERT OR IGNORE INTO devices (id, name, credential_hash) VALUES ($id, $name, $hash)")
			.run({ id: record.id, name: record.name, hash: record.credentialHash });
		return result.changes === 1;
	}

	/** The device's record, or `undefined` when there is none. */
	get(id: string): DeviceRecord | undefined {
		const row = this.database
			.query<{ id: string; name: string; credential_hash: string }, { id: string }>("SELECT id, name, credential_hash FROM devices WHERE id = $id")
			.get({ id });
		return row === null ? undefined : { id: row.id, name: row.name, credentialHash: row.credential_hash };
	}

	delete(id: string): void {
		this.database.query("DELETE FROM devices WHERE id = $id").run({ id });
	}

	close(): void {
		this.database.close();
	}
}
