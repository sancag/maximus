import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KuzuClient } from "../kuzu/client.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import type { KnowledgeEntity, KnowledgeTriple } from "@maximus/shared";

let tmpDir: string;
let client: KuzuClient;
let store: KnowledgeStore;

beforeEach(async () => {
	tmpDir = mkdtempSync(join(tmpdir(), "ks-test-"));
	client = await KuzuClient.open(join(tmpDir, "test.kuzu"));
	store = await KnowledgeStore.create(client);
});

afterEach(async () => {
	await client.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("KnowledgeStore", () => {
	const makeEntity = (overrides: Partial<KnowledgeEntity> = {}): KnowledgeEntity => ({
		id: "e1",
		name: "Instantly API",
		type: "api",
		attributes: { rateLimit: 10 },
		createdBy: "agent-alpha",
		firstSeen: 1000,
		lastUpdated: 1000,
		...overrides,
	});

	const makeTriple = (overrides: Partial<KnowledgeTriple> = {}): KnowledgeTriple => ({
		sourceId: "e1",
		targetId: "e2",
		predicate: "uses",
		scope: "agent",
		validFrom: 1000,
		validTo: undefined,
		confidence: 0.9,
		evidence: "Observed in task logs",
		createdBy: "agent-alpha",
		...overrides,
	});

	it("Test 1: upsertEntity creates a new Entity and getEntity retrieves it with all fields", async () => {
		const entity = makeEntity();
		await store.upsertEntity(entity);

		const retrieved = await store.getEntity("e1");
		expect(retrieved).not.toBeNull();
		expect(retrieved!.id).toBe("e1");
		expect(retrieved!.name).toBe("Instantly API");
		expect(retrieved!.type).toBe("api");
		expect(retrieved!.attributes).toEqual({ rateLimit: 10 });
		expect(retrieved!.createdBy).toBe("agent-alpha");
		expect(retrieved!.firstSeen).toBe(1000);
		expect(retrieved!.lastUpdated).toBe(1000);
	});

	it("Test 2: upsertEntity on existing entity updates fields but preserves firstSeen", async () => {
		const entity = makeEntity();
		await store.upsertEntity(entity);

		await store.upsertEntity({
			...entity,
			name: "Instantly API v2",
			type: "api-v2",
			attributes: { rateLimit: 20 },
			lastUpdated: 2000,
			firstSeen: 9999, // should be ignored on update
		});

		const retrieved = await store.getEntity("e1");
		expect(retrieved).not.toBeNull();
		expect(retrieved!.name).toBe("Instantly API v2");
		expect(retrieved!.type).toBe("api-v2");
		expect(retrieved!.attributes).toEqual({ rateLimit: 20 });
		expect(retrieved!.lastUpdated).toBe(2000);
		expect(retrieved!.firstSeen).toBe(1000); // preserved from first insert
	});

	it("Test 3: insertTriple creates a Related edge with all fields", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Agent Alpha" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Instantly API" }));

		const triple = makeTriple();
		await store.insertTriple(triple);

		const results = await store.getByScope("agent-alpha", []);
		expect(results.length).toBe(1);
		expect(results[0].triple.predicate).toBe("uses");
		expect(results[0].triple.scope).toBe("agent");
		expect(results[0].triple.validFrom).toBe(1000);
		expect(results[0].triple.confidence).toBe(0.9);
		expect(results[0].triple.evidence).toBe("Observed in task logs");
		expect(results[0].triple.createdBy).toBe("agent-alpha");
	});

	it("Test 4: insertTripleWithSupersession supersedes old triple", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Agent Alpha" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Instantly API" }));

		// Insert original triple
		await store.insertTripleWithSupersession(makeTriple({ validFrom: 1000, confidence: 0.8 }));

		// Insert contradicting triple (same source+predicate+target)
		await store.insertTripleWithSupersession(
			makeTriple({ validFrom: 2000, confidence: 0.95, evidence: "Updated observation" }),
		);

		// Only the new triple should be active (validTo=0)
		const active = await store.getByScope("agent-alpha", []);
		expect(active.length).toBe(1);
		expect(active[0].triple.validFrom).toBe(2000);
		expect(active[0].triple.confidence).toBe(0.95);

		// The old triple should exist but have validTo set
		const hasOldActive = await store.findActiveTriple("e1", "uses", "e2");
		// Only one active triple — the new one
		expect(hasOldActive).toBe(true);
	});

	it("Test 5: getByScope with agent scope returns only agent's own active triples", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Alpha" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Tool" }));
		await store.upsertEntity(makeEntity({ id: "e3", name: "Beta" }));

		// agent-alpha's triple
		await store.insertTriple(makeTriple({ createdBy: "agent-alpha", scope: "agent" }));
		// agent-beta's triple (should NOT appear)
		await store.insertTriple(
			makeTriple({ sourceId: "e3", targetId: "e2", createdBy: "agent-beta", scope: "agent" }),
		);

		const results = await store.getByScope("agent-alpha", []);
		expect(results.length).toBe(1);
		expect(results[0].triple.createdBy).toBe("agent-alpha");
	});

	it("Test 6: getByScope returns agent + team + global triples", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Alpha" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Tool" }));
		await store.upsertEntity(makeEntity({ id: "e3", name: "Beta" }));
		await store.upsertEntity(makeEntity({ id: "e4", name: "Global Entity" }));

		// Agent scope — agent-alpha
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent", predicate: "uses" }),
		);
		// Team scope — agent-beta (teammate)
		await store.insertTriple(
			makeTriple({ sourceId: "e3", targetId: "e2", createdBy: "agent-beta", scope: "team", predicate: "depends_on" }),
		);
		// Global scope
		await store.insertTriple(
			makeTriple({
				sourceId: "e4",
				targetId: "e2",
				createdBy: "system",
				scope: "global",
				predicate: "provides",
			}),
		);
		// agent-beta's own agent scope (should NOT appear)
		await store.insertTriple(
			makeTriple({
				sourceId: "e3",
				targetId: "e2",
				createdBy: "agent-beta",
				scope: "agent",
				predicate: "owns",
			}),
		);

		const results = await store.getByScope("agent-alpha", ["agent-beta"]);
		expect(results.length).toBe(3);

		const predicates = results.map((r) => r.triple.predicate).sort();
		expect(predicates).toEqual(["depends_on", "provides", "uses"]);
	});

	it("Test 7: getByScope with empty teamMembers skips team query", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Alpha" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Tool" }));
		await store.upsertEntity(makeEntity({ id: "e3", name: "Global" }));

		// Agent scope
		await store.insertTriple(
			makeTriple({ sourceId: "e1", targetId: "e2", createdBy: "agent-alpha", scope: "agent" }),
		);
		// Team scope (should NOT appear when teamMembers is empty)
		await store.insertTriple(
			makeTriple({ sourceId: "e3", targetId: "e2", createdBy: "agent-beta", scope: "team" }),
		);
		// Global scope
		await store.insertTriple(
			makeTriple({ sourceId: "e3", targetId: "e2", createdBy: "system", scope: "global", predicate: "provides" }),
		);

		const results = await store.getByScope("agent-alpha", []);
		expect(results.length).toBe(2);
		const scopes = results.map((r) => r.triple.scope).sort();
		expect(scopes).toEqual(["agent", "global"]);
	});

	it("Test 8: getEntitiesByCreator returns all entities by a specific agent", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", createdBy: "agent-alpha" }));
		await store.upsertEntity(makeEntity({ id: "e2", createdBy: "agent-alpha" }));
		await store.upsertEntity(makeEntity({ id: "e3", createdBy: "agent-beta" }));

		const alphaEntities = await store.getEntitiesByCreator("agent-alpha");
		expect(alphaEntities.length).toBe(2);
		expect(alphaEntities.every((e) => e.createdBy === "agent-alpha")).toBe(true);
	});

	it("Test 9: team-scoped triples with createdBy=system:promotion are visible via getByScope", async () => {
		await store.upsertEntity(makeEntity({ id: "e1", name: "Source Entity", createdBy: "system:promotion" }));
		await store.upsertEntity(makeEntity({ id: "e2", name: "Target Entity", createdBy: "system:promotion" }));

		// Insert triple with system:promotion as createdBy
		await store.insertTriple(makeTriple({
			sourceId: "e1",
			targetId: "e2",
			scope: "team",
			createdBy: "system:promotion",
			predicate: "promoted_knowledge",
		}));

		const results = await store.getByScope("agent-alpha", ["agent-beta"]);
		expect(results.length).toBe(1);
		expect(results[0].triple.createdBy).toBe("system:promotion");
		expect(results[0].triple.scope).toBe("team");
	});
});
