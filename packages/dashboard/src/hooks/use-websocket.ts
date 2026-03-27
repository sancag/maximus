"use client";

import { useEffect, useRef, useCallback } from "react";
import { useStore } from "./use-store";
import type { AgentEvent } from "@maximus/shared";

const INITIAL_DELAY = 1000;
const MAX_DELAY = 30000;
const MULTIPLIER = 2;

/**
 * Internal connect function, exported for testing.
 * Returns a cleanup function.
 */
const _TASK_EVENT_TYPES = new Set(["task:created", "task:assigned", "task:completed", "task:failed"]);

export function _connect(url: string): () => void {
	const store = useStore.getState();
	let retries = 0;
	let ws: WebSocket | null = null;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;

	function connect() {
		if (disposed) return;
		ws = new WebSocket(url);

		ws.onopen = () => {
			store.setConnectionStatus("connected");
			retries = 0;
			store.syncState();
		};

		ws.onmessage = (event: MessageEvent) => {
			const frame = JSON.parse(event.data);
			if (frame.type === "event") {
				const agentEvent = frame.payload as AgentEvent;
				store.addEvent(agentEvent);
				if (_TASK_EVENT_TYPES.has(agentEvent.type)) {
					store.refreshTasks();
				}
			}
		};

		ws.onclose = () => {
			if (disposed) return;
			store.setConnectionStatus("reconnecting");
			const delay = Math.min(INITIAL_DELAY * MULTIPLIER ** retries, MAX_DELAY);
			retries++;
			timeoutId = setTimeout(connect, delay);
		};

		ws.onerror = () => {
			ws?.close();
		};
	}

	connect();

	return () => {
		disposed = true;
		if (timeoutId) clearTimeout(timeoutId);
		ws?.close();
	};
}

export function useWebSocket(url: string) {
	const wsRef = useRef<WebSocket | null>(null);
	const retriesRef = useRef(0);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const setConnectionStatus = useStore((s) => s.setConnectionStatus);
	const addEvent = useStore((s) => s.addEvent);
	const syncState = useStore((s) => s.syncState);
	const refreshTasks = useStore((s) => s.refreshTasks);

	const TASK_EVENT_TYPES = new Set(["task:created", "task:assigned", "task:completed", "task:failed"]);

	const connect = useCallback(() => {
		const ws = new WebSocket(url);
		wsRef.current = ws;

		ws.onopen = () => {
			setConnectionStatus("connected");
			retriesRef.current = 0;
			syncState();
		};

		ws.onmessage = (event: MessageEvent) => {
			const frame = JSON.parse(event.data);
			if (frame.type === "event") {
				const agentEvent = frame.payload as AgentEvent;
				addEvent(agentEvent);
				if (TASK_EVENT_TYPES.has(agentEvent.type)) {
					refreshTasks();
				}
			}
		};

		ws.onclose = () => {
			setConnectionStatus("reconnecting");
			const delay = Math.min(
				INITIAL_DELAY * MULTIPLIER ** retriesRef.current,
				MAX_DELAY,
			);
			retriesRef.current++;
			timeoutRef.current = setTimeout(connect, delay);
		};

		ws.onerror = () => {
			ws.close();
		};
	}, [url, setConnectionStatus, addEvent, syncState, refreshTasks]);

	useEffect(() => {
		connect();
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			wsRef.current?.close();
		};
	}, [connect]);
}
