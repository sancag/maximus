import { describe, it, expect } from "vitest";
import {
	getOrchestratorPrompt,
	getOrchestratorDefinition,
	DOCS_AGENTS,
	DOCS_SKILLS,
	DOCS_VAULT,
} from "../templates/orchestrator-system-prompt.js";

describe("orchestrator system prompt", () => {
	it("replaces {{name}} with provided agent name", () => {
		const prompt = getOrchestratorPrompt("atlas");
		expect(prompt).toContain("You are atlas");
		expect(prompt).not.toContain("{{name}}");
	});

	it("is slim — references docs/ instead of inlining knowledge", () => {
		const prompt = getOrchestratorPrompt("test");
		expect(prompt).toContain("docs/");
		expect(prompt).not.toContain("Frontmatter Fields");
		expect(prompt).not.toContain("inject_as");
	});

	it("includes onboarding instructions", () => {
		const prompt = getOrchestratorPrompt("test");
		expect(prompt).toContain("[ONBOARDING]");
		expect(prompt).toContain("user.md");
	});
});

describe("getOrchestratorDefinition", () => {
	it("wraps prompt in markdown frontmatter", () => {
		const def = getOrchestratorDefinition("atlas");
		expect(def).toMatch(/^---\nname: atlas/);
		expect(def).toContain("maxTurns: 50");
		expect(def).toContain("You are atlas");
	});

	it("does not reference maximus-admin skill", () => {
		const def = getOrchestratorDefinition("atlas");
		expect(def).not.toContain("maximus-admin");
	});

	it("has no unresolved template placeholders", () => {
		const def = getOrchestratorDefinition("mybot");
		expect(def).not.toContain("{{name}}");
	});
});

describe("docs exports", () => {
	it("DOCS_AGENTS contains agent creation guide", () => {
		expect(DOCS_AGENTS).toContain("Frontmatter Fields");
		expect(DOCS_AGENTS).toContain("reportsTo");
		expect(DOCS_AGENTS).toContain("Example");
	});

	it("DOCS_SKILLS contains skill creation guide", () => {
		expect(DOCS_SKILLS).toContain("credentials");
		expect(DOCS_SKILLS).toContain("inject_as");
		expect(DOCS_SKILLS).toContain("http");
	});

	it("DOCS_VAULT contains vault usage guide", () => {
		expect(DOCS_VAULT).toContain("AES-256-GCM");
		expect(DOCS_VAULT).toContain("/vault set");
	});
});

it("includes memory system instructions", () => {
	const prompt = getOrchestratorPrompt("test");
	expect(prompt).toContain("Agent Memory");
	expect(prompt).toContain("memory status");
	expect(prompt).toContain("memory inspect");
	expect(prompt).toContain("memory promote");
});
