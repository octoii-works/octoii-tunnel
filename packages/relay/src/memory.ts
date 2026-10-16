import type { DeviceRecord, DeviceStore } from "./host.ts";

/** Volatile storage for development and tests. The host owns persistence. */
export function createMemoryDeviceStore(): DeviceStore {
	const records = new Map<string, DeviceRecord>();
	return {
		async create(record) {
			if (records.has(record.id)) return false;
			records.set(record.id, { ...record });
			return true;
		},
		async get(id) {
			const record = records.get(id);
			return record ? { ...record } : undefined;
		},
		async remove(id) {
			records.delete(id);
		},
	};
}
