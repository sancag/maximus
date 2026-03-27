import WebSocket from "ws";
import type { AgentEventType } from "@maximus/shared";
import type { StatusState } from "./status-footer.js";

interface WebSocketFrame {
	type: "event" | "connected" | "error";
	event?: string;
	payload: Record<string, unknown>;
	seq: number;
}

export class StatusWebSocket {
	private ws: WebSocket | null = null;
	private attempt = 0;
	private maxDelay = 10_000;
	private destroyed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private uptimeTimer: ReturnType<typeof setInterval> | null = null;
	private serverStartedAt = 0;
	private onUpdate: (partial: Partial<StatusState>) => void;
	private taskDelta = 0;

	constructor(onUpdate: (partial: Partial<StatusState>) => void) {
		this.onUpdate = onUpdate;
	}

	connect(port: number): void {
		if (this.destroyed) return;

		try {
			this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		} catch {
			this.scheduleReconnect(port);
			return;
		}

		this.ws.on("open", () => {
			this.attempt = 0;
			this.onUpdate({ serverOnline: true });
		});

		this.ws.on("message", (data) => {
			try {
				const frame = JSON.parse(data.toString()) as WebSocketFrame;
				this.handleFrame(frame);
			} catch {
				// Ignore malformed frames
			}
		});

		this.ws.on("close", () => {
			if (this.uptimeTimer) {
				clearInterval(this.uptimeTimer);
				this.uptimeTimer = null;
			}
			this.onUpdate({ serverOnline: false, activeAgent: undefined });
			if (!this.destroyed) {
				this.scheduleReconnect(port);
			}
		});

		this.ws.on("error", () => {
			// 'close' event fires after 'error', reconnect handled there
		});
	}

	private scheduleReconnect(port: number): void {
		if (this.destroyed) return;
		const delay = Math.min(1000 * 2 ** this.attempt, this.maxDelay);
		this.attempt++;
		this.reconnectTimer = setTimeout(() => this.connect(port), delay);
	}

	private formatUptime(ms: number): string {
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m`;
		const h = Math.floor(m / 60);
		const rm = m % 60;
		return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
	}

	private handleFrame(frame: WebSocketFrame): void {
		if (frame.type === "connected") {
			const payload = frame.payload;
			const uptimeMs = (payload.uptimeMs as number) ?? 0;
			this.serverStartedAt = Date.now() - uptimeMs;
			this.taskDelta = (payload.activeTasks as number) ?? 0;

			this.onUpdate({
				serverOnline: true,
				agentCount: (payload.agentCount as number) ?? 0,
				taskCount: this.taskDelta,
				uptime: this.formatUptime(uptimeMs),
			});

			// Tick uptime every 30s
			if (this.uptimeTimer) clearInterval(this.uptimeTimer);
			this.uptimeTimer = setInterval(() => {
				this.onUpdate({ uptime: this.formatUptime(Date.now() - this.serverStartedAt) });
			}, 30_000);
			return;
		}

		if (frame.type !== "event" || !frame.event) return;

		const event = frame.event as AgentEventType;
		const payload = frame.payload;

		switch (event) {
			case "agent:delegation":
				this.onUpdate({
					activeAgent: `${payload.agentName} → ${(payload.payload as Record<string, unknown>)?.targetAgent || "agent"}`,
				});
				break;
			case "session:start":
				this.onUpdate({
					activeAgent: `${payload.agentName} (working...)`,
				});
				break;
			case "session:end":
			case "agent:completion":
				this.onUpdate({ activeAgent: undefined });
				break;
			case "task:created":
				this.taskDelta++;
				this.onUpdate({ taskCount: this.taskDelta });
				break;
			case "task:completed":
			case "task:failed":
				this.taskDelta--;
				this.onUpdate({ taskCount: Math.max(0, this.taskDelta), activeAgent: undefined });
				break;
		}
	}

	destroy(): void {
		this.destroyed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.uptimeTimer) {
			clearInterval(this.uptimeTimer);
			this.uptimeTimer = null;
		}
		if (this.ws) {
			this.ws.removeAllListeners();
			this.ws.close();
			this.ws = null;
		}
	}
}
