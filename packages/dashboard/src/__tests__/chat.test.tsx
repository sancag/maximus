import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock react-markdown since it's ESM-only
vi.mock("react-markdown", () => ({
	default: ({ children }: { children: string }) =>
		createElement("div", null, children),
}));

// Mock the api module
vi.mock("@/lib/api", () => ({
	api: {
		sendMessage: vi.fn(),
	},
}));

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

describe("ChatView", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	async function getModules() {
		vi.resetModules();
		const storeModule = await import("@/hooks/use-store");
		const chatModule = await import("@/components/views/chat");
		return {
			useStore: storeModule.useStore,
			ChatView: chatModule.ChatView,
		};
	}

	it("renders empty state when no messages", async () => {
		const { ChatView } = await getModules();
		render(createElement(ChatView));
		expect(screen.getByText("Mission Control Ready")).toBeInTheDocument();
		expect(
			screen.getByText(
				"Send a message to your orchestrator agent to begin. Your agent team is standing by.",
			),
		).toBeInTheDocument();
	});

	it("renders user message with correct content", async () => {
		const { useStore, ChatView } = await getModules();
		useStore.getState().addChatMessage({
			id: "msg-1",
			role: "user",
			content: "Hello orchestrator",
			timestamp: Date.now(),
		});

		render(createElement(ChatView));
		expect(screen.getByText("Hello orchestrator")).toBeInTheDocument();
	});

	it("renders agent message with markdown content", async () => {
		const { useStore, ChatView } = await getModules();
		useStore.getState().addChatMessage({
			id: "msg-1",
			role: "assistant",
			content: "Here is a **bold** response",
			timestamp: Date.now(),
		});

		render(createElement(ChatView));
		expect(
			screen.getByText("Here is a **bold** response"),
		).toBeInTheDocument();
	});
});
