import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteClient } from "../sqlite/client.js";
import { EpisodeStore } from "../sqlite/episodes.js";
import type { Episode } from "@maximus/shared";

let tmpDir: string;
let client: SqliteClient;
let store: EpisodeStore;

afterEach(() => {
	client?.close();
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

function setup() {
	tmpDir = mkdtempSync(join(tmpdir(), "episode-store-test-"));
	client = SqliteClient.open(join(tmpDir, "test.db"));
	store = new EpisodeStore(client.raw);
}

let _epCounter = 0;

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
	const id = `ep-${++_epCounter}`;
	return {
		id,
		agentName: "test-agent",
		timestamp: Date.now(),
		taskDescription: "Test task",
		outcome: "success",
		lessonsLearned: [],
		effectiveStrategies: [],
		failurePatterns: [],
		toolsUsed: [],
		tags: [],
		utilityScore: 0,
		retrievalCount: 0,
		...overrides,
	};
}

describe("EpisodeStore", () => {
	it("store and getById round-trip", () => {
		setup();
		const ep = makeEpisode({
			lessonsLearned: ["lesson1"],
			toolsUsed: ["bash"],
			tags: ["test-agent", "success"],
		});
		store.store(ep);

		const result = store.getById(ep.id);
		expect(result).not.toBeNull();
		expect(result!.id).toBe(ep.id);
		expect(result!.agentName).toBe(ep.agentName);
		expect(result!.outcome).toBe(ep.outcome);
		expect(result!.lessonsLearned).toEqual(["lesson1"]);
		expect(result!.toolsUsed).toEqual(["bash"]);
		expect(result!.tags).toEqual(["test-agent", "success"]);
	});

	it("store serializes array fields as JSON strings", () => {
		setup();
		const ep = makeEpisode({
			lessonsLearned: ["lesson1", "lesson2"],
			toolsUsed: ["bash"],
		});
		store.store(ep);

		const result = store.getById(ep.id);
		expect(result).not.toBeNull();
		expect(Array.isArray(result!.lessonsLearned)).toBe(true);
		expect(result!.lessonsLearned).toEqual(["lesson1", "lesson2"]);
		expect(result!.toolsUsed).toEqual(["bash"]);
	});

	it("getByAgent returns episodes ordered by timestamp DESC", () => {
		setup();
		const ep1 = makeEpisode({ timestamp: 100 });
		const ep2 = makeEpisode({ timestamp: 300 });
		const ep3 = makeEpisode({ timestamp: 200 });

		store.store(ep1);
		store.store(ep2);
		store.store(ep3);

		const results = store.getByAgent("test-agent");
		expect(results).toHaveLength(3);
		expect(results[0].timestamp).toBe(300);
		expect(results[1].timestamp).toBe(200);
		expect(results[2].timestamp).toBe(100);
	});

	it("getByAgent respects limit parameter", () => {
		setup();
		for (let i = 0; i < 5; i++) {
			store.store(makeEpisode({ timestamp: i * 100 }));
		}

		const results = store.getByAgent("test-agent", 2);
		expect(results).toHaveLength(2);
	});

	it("getByAgent only returns episodes for specified agent", () => {
		setup();
		store.store(makeEpisode({ agentName: "agent-a", timestamp: 100 }));
		store.store(makeEpisode({ agentName: "agent-a", timestamp: 200 }));
		store.store(makeEpisode({ agentName: "agent-b", timestamp: 300 }));

		const results = store.getByAgent("agent-a");
		expect(results).toHaveLength(2);
		for (const ep of results) {
			expect(ep.agentName).toBe("agent-a");
		}
	});

	it("getById returns null for nonexistent id", () => {
		setup();
		const result = store.getById("nonexistent");
		expect(result).toBeNull();
	});

	it("pruneExcess deletes lowest-utility episodes when count exceeds max", () => {
		setup();
		const scores = [10, 5, 1, 8, 3];
		for (const utilityScore of scores) {
			store.store(makeEpisode({ utilityScore, timestamp: Date.now() }));
		}

		const deleted = store.pruneExcess("test-agent", 3);
		expect(deleted).toBe(2);

		const remaining = store.getByAgent("test-agent", 10);
		expect(remaining).toHaveLength(3);

		// Lowest utility scores (1 and 3) should be gone
		const remainingScores = remaining.map((ep) => ep.utilityScore).sort((a, b) => a - b);
		expect(remainingScores).toEqual([5, 8, 10]);
	});

	it("pruneExcess returns 0 when count is within limit", () => {
		setup();
		store.store(makeEpisode());
		store.store(makeEpisode());

		const deleted = store.pruneExcess("test-agent", 5);
		expect(deleted).toBe(0);
	});

	it("pruneExcess breaks ties by timestamp ASC (oldest first)", () => {
		setup();
		// All have utilityScore 0, different timestamps
		store.store(makeEpisode({ utilityScore: 0, timestamp: 100 }));
		store.store(makeEpisode({ utilityScore: 0, timestamp: 200 }));
		store.store(makeEpisode({ utilityScore: 0, timestamp: 300 }));

		const deleted = store.pruneExcess("test-agent", 1);
		expect(deleted).toBe(2);

		const remaining = store.getByAgent("test-agent", 10);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].timestamp).toBe(300);
	});
});
