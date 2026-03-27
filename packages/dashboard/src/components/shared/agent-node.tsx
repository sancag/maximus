"use client";

import { cn } from "@/lib/utils";
import { truncateId } from "@/lib/utils";

type AgentStatus = "idle" | "active" | "error";

interface AgentNodeProps {
	agent: { name: string; reportsTo?: string; description: string };
	status: AgentStatus;
	currentTask?: string;
	onClick: () => void;
}

export function AgentNode({ agent, status, currentTask, onClick }: AgentNodeProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-[200px] bg-surface border border-border rounded-lg p-4 cursor-pointer transition-all duration-200 text-left",
				"hover:bg-elevated",
				status === "active" &&
					"shadow-[var(--glow-accent)] animate-[pulse-glow_2000ms_ease-in-out_infinite]",
				status === "error" && "shadow-[var(--glow-error)]",
			)}
		>
			<div className="text-sm font-semibold text-text-primary">
				{agent.name}
			</div>

			<div className="mt-1.5">
				<span
					className={cn(
						"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
						status === "idle" && "border border-success/30 text-success",
						status === "active" && "border border-accent/30 text-accent",
						status === "error" && "border border-destructive/30 text-destructive",
					)}
				>
					<span
						className={cn(
							"w-1.5 h-1.5 rounded-full",
							status === "idle" && "bg-success",
							status === "active" &&
								"bg-accent animate-[pulse-dot_1500ms_ease-in-out_infinite]",
							status === "error" && "bg-destructive",
						)}
					/>
					{status}
				</span>
			</div>

			{currentTask && (
				<div className="text-xs text-text-secondary mt-2 truncate">
					{currentTask.length > 30
						? `${currentTask.slice(0, 30)}...`
						: truncateId(currentTask)}
				</div>
			)}
		</button>
	);
}
