import { useState, useEffect, useCallback, useRef } from "react";
import type { StatusState } from "../../repl/status-footer.js";
import { StatusWebSocket } from "../../repl/ws-client.js";
import { hasProject } from "../../lib/project.js";
import { getConfig } from "../../lib/config.js";
import { readPid, isProcessRunning } from "../../lib/pid.js";

export interface UseServerStatusResult {
	status: StatusState;
	setStatus: (updater: (prev: StatusState) => StatusState) => void;
	updateStatus: (partial: Partial<StatusState>) => void;
}

function getInitialStatus(): StatusState {
	return {
		serverOnline: false,
		agentCount: 0,
		taskCount: 0,
		uptime: "0s",
		projectInitialized: hasProject(),
	};
}

export function useServerStatus(): UseServerStatusResult {
	const [status, setStatus] = useState<StatusState>(getInitialStatus);
	const wsRef = useRef<StatusWebSocket | null>(null);

	const updateStatus = useCallback((partial: Partial<StatusState>) => {
		setStatus((prev) => ({ ...prev, ...partial }));
	}, []);

	// Always run WebSocket — it reconnects automatically
	useEffect(() => {
		try {
			const config = getConfig();
			const ws = new StatusWebSocket(updateStatus);
			ws.connect(config.port);
			wsRef.current = ws;

			return () => {
				ws.destroy();
				wsRef.current = null;
			};
		} catch {
			// Config not available yet
			return;
		}
	}, [updateStatus]);

	return { status, setStatus, updateStatus };
}
