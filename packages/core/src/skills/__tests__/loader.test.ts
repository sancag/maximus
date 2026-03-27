import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadSkillDefinition, loadSkillsFromDirectory } from "../loader.js";
import {
	yamlParamToZod,
	buildToolParamsSchema,
} from "../composer.js";
import { EventBus } from "../../events/bus.js";
import type { AgentEvent } from "@maximus/shared";

const EXAMPLE_SKILL_PATH = path.resolve(
	import.meta.dirname,
	"../../../../../skills/example-skill.yaml",
);

// --- Skill Loader Tests ---

describe("loadSkillDefinition", () => {
	it("parses a valid YAML skill file into SkillDefinition", () => {
		const skill = loadSkillDefinition(EXAMPLE_SKILL_PATH);

		expect(skill.name).toBe("github-operations");
		expect(skill.description).toBe(
			"Create and manage GitHub issues, PRs, and repositories",
		);
		expect(skill.version).toBe("1.0");
		expect(skill.tools).toHaveLength(1);
		expect(skill.tools[0].name).toBe("github_create_issue");
		expect(skill.tools[0].parameters).toHaveProperty("repo");
		expect(skill.credentials).toHaveLength(1);
		expect(skill.credentials[0].name).toBe("github_token");
	});

	it("throws with descriptive error when tools array is missing", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
		const badFile = path.join(tmpDir, "bad-skill.yaml");
		fs.writeFileSync(
			badFile,
			`name: bad-skill
description: Missing tools
`,
		);

		expect(() => loadSkillDefinition(badFile)).toThrow(/tool/i);

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("throws on non-existent file", () => {
		expect(() =>
			loadSkillDefinition("/nonexistent/path/skill.yaml"),
		).toThrow(/ENOENT|not found/i);
	});
});

describe("loadSkillsFromDirectory", () => {
	it("loads all .yaml/.yml files from a directory", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-test-"));
		const toolDef = `
  - name: test_tool
    description: A test tool
    parameters:
      arg1:
        type: string
        description: Test arg`;

		fs.writeFileSync(
			path.join(tmpDir, "a.yaml"),
			`name: skill-a
description: Skill A
tools:${toolDef}
`,
		);
		fs.writeFileSync(
			path.join(tmpDir, "b.yml"),
			`name: skill-b
description: Skill B
tools:${toolDef}
`,
		);
		// Non-yaml file should be ignored
		fs.writeFileSync(path.join(tmpDir, "readme.txt"), "ignore me");

		const skills = loadSkillsFromDirectory(tmpDir);
		expect(skills).toHaveLength(2);
		expect(skills.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);

		fs.rmSync(tmpDir, { recursive: true });
	});
});

// --- Composer Tests (unit test param-to-Zod conversion) ---

describe("yamlParamToZod", () => {
	it("converts string type parameter to Zod string schema", () => {
		const schema = yamlParamToZod({ type: "string", description: "A string" });
		expect(schema.parse("hello")).toBe("hello");
		expect(() => schema.parse(123)).toThrow();
	});

	it("converts number type parameter to Zod number schema", () => {
		const schema = yamlParamToZod({ type: "number", description: "A number" });
		expect(schema.parse(42)).toBe(42);
		expect(() => schema.parse("not a number")).toThrow();
	});

	it("converts boolean type parameter to Zod boolean schema", () => {
		const schema = yamlParamToZod({
			type: "boolean",
			description: "A boolean",
		});
		expect(schema.parse(true)).toBe(true);
	});

	it("defaults unknown types to string schema", () => {
		const schema = yamlParamToZod({
			type: "unknown" as any,
			description: "Unknown",
		});
		expect(schema.parse("fallback")).toBe("fallback");
	});
});

describe("buildToolParamsSchema", () => {
	it("builds a Zod object schema from tool parameter definitions", () => {
		const toolDef = {
			name: "test_tool",
			description: "A test tool",
			parameters: {
				repo: { type: "string" as const, description: "Repository", required: true },
				count: { type: "number" as const, description: "Count", required: true },
			},
			credentials: [],
		};

		const schema = buildToolParamsSchema(toolDef as any);
		const result = schema.parse({ repo: "owner/repo", count: 5 });
		expect(result).toEqual({ repo: "owner/repo", count: 5 });
	});
});

// --- Event Bus Tests ---

describe("EventBus", () => {
	let bus: EventBus;

	function makeEvent(
		type: AgentEvent["type"],
		overrides?: Partial<AgentEvent>,
	): AgentEvent {
		return {
			id: "evt-1",
			timestamp: Date.now(),
			sessionId: "s1",
			agentName: "test-agent",
			type,
			payload: {},
			...overrides,
		};
	}

	beforeEach(() => {
		bus = new EventBus();
	});

	it("delivers events to subscribers registered via on()", () => {
		const received: AgentEvent[] = [];
		bus.on("agent:message", (e) => received.push(e));

		const event = makeEvent("agent:message");
		bus.emit(event);

		expect(received).toHaveLength(1);
		expect(received[0]).toBe(event);
	});

	it("only delivers matching event types to typed subscribers", () => {
		const received: AgentEvent[] = [];
		bus.on("agent:message", (e) => received.push(e));

		bus.emit(makeEvent("agent:tool_call"));
		bus.emit(makeEvent("agent:message"));

		expect(received).toHaveLength(1);
		expect(received[0].type).toBe("agent:message");
	});

	it("delivers all events to onAny() subscribers", () => {
		const received: AgentEvent[] = [];
		bus.onAny((e) => received.push(e));

		bus.emit(makeEvent("agent:message"));
		bus.emit(makeEvent("agent:tool_call"));
		bus.emit(makeEvent("agent:error"));

		expect(received).toHaveLength(3);
	});

	it("returns unsubscribe function from on()", () => {
		const received: AgentEvent[] = [];
		const unsub = bus.on("agent:message", (e) => received.push(e));

		bus.emit(makeEvent("agent:message"));
		expect(received).toHaveLength(1);

		unsub();
		bus.emit(makeEvent("agent:message"));
		expect(received).toHaveLength(1); // no new events after unsub
	});

	it("returns unsubscribe function from onAny()", () => {
		const received: AgentEvent[] = [];
		const unsub = bus.onAny((e) => received.push(e));

		bus.emit(makeEvent("agent:message"));
		unsub();
		bus.emit(makeEvent("agent:message"));

		expect(received).toHaveLength(1);
	});
});
