"use client";

import type { AgentEvent } from "@maximus/shared";
import { EVENT_CONFIG } from "@/lib/constants";
import { formatRelativeTime } from "@/lib/utils";

interface EventCardProps {
	event: AgentEvent;
	expanded: boolean;
	onToggle: () => void;
}

function getEventSummary(event: AgentEvent): string {
	const p = event.payload;
	switch (event.type) {
		case "agent:message":
			return "Sent a message";
		case "agent:tool_call":
			return `Called tool: ${(p.toolName as string) || ((p.toolUse as Record<string, unknown>)?.name as string) || "unknown"}`;
		case "agent:tool_result":
			return "Tool returned result";
		case "agent:delegation":
			return `Delegated to ${(p.toAgent as string) || "agent"}`;
		case "agent:completion":
			return "Completed";
		case "agent:error":
			return `Error: ${(p.error as string) || "unknown"}`;
		case "session:start":
			return "Session started";
		case "session:end":
			return "Session ended";
		case "task:created":
			return "Task created";
		case "task:assigned":
			return "Task assigned";
		case "task:completed":
			return "Task completed";
		case "task:failed":
			return "Task failed";
		default:
			return event.type;
	}
}

export function EventCard({ event, expanded, onToggle }: EventCardProps) {
	const config = EVENT_CONFIG[event.type as keyof typeof EVENT_CONFIG];
	if (!config) return null;
	const Icon = config.icon;

	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onToggle}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onToggle();
				}
			}}
			className="cursor-pointer rounded-lg border border-border bg-surface p-4 transition-colors duration-150 hover:bg-elevated"
		>
			<div className="flex items-center gap-3">
				<Icon size={20} style={{ color: config.color }} />
				<span className="truncate text-sm font-medium text-text-primary">
					{event.agentName}
				</span>
				<span className="flex-1 truncate text-sm text-text-secondary">
					{getEventSummary(event)}
				</span>
				<span className="whitespace-nowrap text-xs text-text-secondary">
					{formatRelativeTime(event.timestamp)}
				</span>
			</div>
			{expanded && (
				<div className="mt-3 rounded border-t border-border bg-elevated p-3 pt-3">
					<pre className="overflow-x-auto font-mono text-xs text-text-secondary">
						{JSON.stringify(event.payload, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
