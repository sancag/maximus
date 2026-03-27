import { describe, it, expect } from 'vitest';

describe('TUI module exports', () => {
	it('exports startTui from tui/index', async () => {
		const mod = await import('../tui/index.js');
		expect(mod.startTui).toBeDefined();
		expect(typeof mod.startTui).toBe('function');
	});

	it('exports App from tui/App', async () => {
		const mod = await import('../tui/App.js');
		expect(mod.App).toBeDefined();
		expect(typeof mod.App).toBe('function');
	});

	it('exports MarkdownText component', async () => {
		const mod = await import('../tui/components/MarkdownText.js');
		expect(mod.MarkdownText).toBeDefined();
	});

	it('exports ChatMessage component with Message type', async () => {
		const mod = await import('../tui/components/ChatMessage.js');
		expect(mod.ChatMessage).toBeDefined();
	});

	it('exports useChat hook', async () => {
		const mod = await import('../tui/hooks/useChat.js');
		expect(mod.useChat).toBeDefined();
	});

	it('exports useServerStatus hook', async () => {
		const mod = await import('../tui/hooks/useServerStatus.js');
		expect(mod.useServerStatus).toBeDefined();
	});
});

describe('program integration', () => {
	it('program default action does not import startRepl', async () => {
		const fs = await import('node:fs');
		const url = await import('node:url');
		const programPath = url.fileURLToPath(new URL('../program.ts', import.meta.url));
		const src = fs.readFileSync(programPath, 'utf-8');
		expect(src).not.toContain("from './repl/index.js'");
		expect(src).not.toContain('from "./repl/index.js"');
		expect(src).toContain('tui/index.js');
	});
});
