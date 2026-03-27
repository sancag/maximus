import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getPidPath } from "./project.js";

export { getPidPath as PID_PATH_FN } from "./project.js";

function pidPath(): string {
	return getPidPath();
}

export function writePid(pid: number): void {
	const p = pidPath();
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, String(pid), "utf-8");
}

export function readPid(): number | null {
	return readPidFrom(pidPath());
}

export function readPidFrom(path: string): number | null {
	if (!existsSync(path)) return null;
	const raw = readFileSync(path, "utf-8").trim();
	const pid = parseInt(raw, 10);
	return Number.isNaN(pid) ? null : pid;
}

export function removePid(): void {
	removePidAt(pidPath());
}

export function removePidAt(path: string): void {
	if (existsSync(path)) unlinkSync(path);
}

export function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
