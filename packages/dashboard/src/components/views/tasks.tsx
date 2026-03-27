"use client";

import { useState, useMemo } from "react";
import { ChevronUp, ChevronDown, ListChecks } from "lucide-react";
import type { Task, TaskStatus } from "@maximus/shared";
import { useStore } from "@/hooks/use-store";
import { cn, formatRelativeTime, truncateId } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";
import { SkeletonTasks } from "@/components/shared/skeleton";

type SortColumn = "id" | "agentName" | "status" | "createdAt" | "updatedAt";
type SortDirection = "asc" | "desc";

const STATUS_BADGE_CLASSES: Record<
	TaskStatus,
	{ text: string; bg: string }
> = {
	created: { text: "text-text-secondary", bg: "bg-text-secondary/10" },
	assigned: { text: "text-accent", bg: "bg-accent/10" },
	"in-progress": { text: "text-warning", bg: "bg-warning/10" },
	completed: { text: "text-success", bg: "bg-success/10" },
	failed: { text: "text-destructive", bg: "bg-destructive/10" },
};

const ALL_STATUSES: Array<TaskStatus | "all"> = [
	"all",
	"created",
	"assigned",
	"in-progress",
	"completed",
	"failed",
];

function sortTasks(
	tasks: Task[],
	column: SortColumn,
	direction: SortDirection,
): Task[] {
	return [...tasks].sort((a, b) => {
		let cmp = 0;
		switch (column) {
			case "id":
				cmp = a.id.localeCompare(b.id);
				break;
			case "agentName":
				cmp = a.agentName.localeCompare(b.agentName);
				break;
			case "status":
				cmp = a.status.localeCompare(b.status);
				break;
			case "createdAt":
				cmp = a.createdAt - b.createdAt;
				break;
			case "updatedAt":
				cmp = a.updatedAt - b.updatedAt;
				break;
		}
		return direction === "asc" ? cmp : -cmp;
	});
}

function SortIndicator({
	column,
	activeColumn,
	direction,
}: {
	column: SortColumn;
	activeColumn: SortColumn;
	direction: SortDirection;
}) {
	if (column !== activeColumn) return null;
	return direction === "asc" ? (
		<ChevronUp size={14} className="inline ml-1" />
	) : (
		<ChevronDown size={14} className="inline ml-1" />
	);
}

function TaskExpandedRow({ task }: { task: Task }) {
	return (
		<tr>
			<td colSpan={6} className="px-4 py-0">
				<div className="bg-elevated p-4 rounded mb-2">
					<div>
						<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
							Prompt
						</span>
						<p className="text-sm text-text-primary mt-1">{task.prompt}</p>
					</div>
					<div className="mt-3">
						<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
							Parent Task
						</span>
						<p className="text-sm text-text-primary mt-1">
							{task.parentTaskId ? truncateId(task.parentTaskId) : "None"}
						</p>
					</div>
					{task.status === "completed" && task.result && (
						<div className="mt-3">
							<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
								Result
							</span>
							<p className="text-sm text-text-primary mt-1">{task.result}</p>
						</div>
					)}
					{task.status === "failed" && task.error && (
						<div className="mt-3">
							<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
								Error
							</span>
							<p className="text-sm text-destructive mt-1">{task.error}</p>
						</div>
					)}
					<div className="mt-3">
						<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
							Token Usage
						</span>
						<p className="text-sm text-text-primary mt-1">
							{task.tokenUsage.toLocaleString()}
						</p>
					</div>
				</div>
			</td>
		</tr>
	);
}

export function TasksView() {
	const tasks = useStore((s) => s.tasks);
	const connectionStatus = useStore((s) => s.connectionStatus);

	const [agentFilter, setAgentFilter] = useState("");
	const [traceFilter, setTraceFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
	const [sortColumn, setSortColumn] = useState<SortColumn>("createdAt");
	const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
	const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

	const filteredTasks = useMemo(() => {
		let result = tasks;
		if (agentFilter) {
			const lower = agentFilter.toLowerCase();
			result = result.filter((t) =>
				t.agentName.toLowerCase().includes(lower),
			);
		}
		if (traceFilter) {
			const lower = traceFilter.toLowerCase();
			result = result.filter((t) =>
				t.traceId.toLowerCase().includes(lower),
			);
		}
		if (statusFilter !== "all") {
			result = result.filter((t) => t.status === statusFilter);
		}
		return sortTasks(result, sortColumn, sortDirection);
	}, [tasks, agentFilter, traceFilter, statusFilter, sortColumn, sortDirection]);

	const handleSort = (column: SortColumn) => {
		if (sortColumn === column) {
			setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortColumn(column);
			setSortDirection("asc");
		}
	};

	// Loading state
	if (tasks.length === 0 && connectionStatus === "connecting") {
		return <SkeletonTasks />;
	}

	// Empty state
	if (tasks.length === 0) {
		return (
			<EmptyState
				icon={ListChecks}
				heading="No Tasks"
				body="Tasks will appear here when agents begin delegating work."
			/>
		);
	}

	const headerClasses =
		"text-xs font-medium text-text-secondary uppercase tracking-wider px-4 py-3 text-left cursor-pointer select-none hover:text-text-primary transition-colors";

	return (
		<div className="flex flex-col h-full">
			{/* Filter bar */}
			<div className="flex flex-row gap-3 p-4 border-b border-border flex-shrink-0">
				<input
					type="text"
					placeholder="Filter by agent..."
					value={agentFilter}
					onChange={(e) => setAgentFilter(e.target.value)}
					className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary w-48 outline-none focus:border-accent transition-colors"
				/>
				<input
					type="text"
					placeholder="Filter by trace ID..."
					value={traceFilter}
					onChange={(e) => setTraceFilter(e.target.value)}
					className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary w-48 outline-none focus:border-accent transition-colors"
				/>
				<select
					value={statusFilter}
					onChange={(e) =>
						setStatusFilter(e.target.value as TaskStatus | "all")
					}
					className="bg-surface border border-border rounded px-3 py-1.5 text-sm text-text-primary outline-none focus:border-accent transition-colors"
				>
					{ALL_STATUSES.map((s) => (
						<option key={s} value={s}>
							{s === "all" ? "All" : s}
						</option>
					))}
				</select>
			</div>

			{/* Table */}
			<div className="flex-1 overflow-auto">
				<table className="w-full">
					<thead className="bg-surface sticky top-0 z-10">
						<tr>
							<th
								className={headerClasses}
								onClick={() => handleSort("id")}
							>
								Task ID
								<SortIndicator
									column="id"
									activeColumn={sortColumn}
									direction={sortDirection}
								/>
							</th>
							<th
								className={headerClasses}
								onClick={() => handleSort("agentName")}
							>
								Agent
								<SortIndicator
									column="agentName"
									activeColumn={sortColumn}
									direction={sortDirection}
								/>
							</th>
							<th
								className={headerClasses}
								onClick={() => handleSort("status")}
							>
								Status
								<SortIndicator
									column="status"
									activeColumn={sortColumn}
									direction={sortDirection}
								/>
							</th>
							<th className={cn(headerClasses, "cursor-default hover:text-text-secondary")}>
								Trace ID
							</th>
							<th
								className={headerClasses}
								onClick={() => handleSort("createdAt")}
							>
								Created
								<SortIndicator
									column="createdAt"
									activeColumn={sortColumn}
									direction={sortDirection}
								/>
							</th>
							<th
								className={headerClasses}
								onClick={() => handleSort("updatedAt")}
							>
								Updated
								<SortIndicator
									column="updatedAt"
									activeColumn={sortColumn}
									direction={sortDirection}
								/>
							</th>
						</tr>
					</thead>
					<tbody>
						{filteredTasks.map((task) => (
							<>
								<tr
									key={task.id}
									onClick={() =>
										setExpandedTaskId(
											expandedTaskId === task.id ? null : task.id,
										)
									}
									className="border-b border-border hover:bg-elevated cursor-pointer transition-colors"
								>
									<td className="px-4 py-3 text-sm font-mono text-text-secondary">
										{truncateId(task.id)}
									</td>
									<td className="px-4 py-3 text-sm text-text-primary">
										{task.agentName}
									</td>
									<td className="px-4 py-3 text-sm">
										<span
											className={cn(
												"inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
												STATUS_BADGE_CLASSES[task.status].text,
												STATUS_BADGE_CLASSES[task.status].bg,
											)}
										>
											{task.status}
										</span>
									</td>
									<td className="px-4 py-3 text-sm font-mono text-text-secondary">
										{truncateId(task.traceId)}
									</td>
									<td className="px-4 py-3 text-sm text-text-secondary">
										{formatRelativeTime(task.createdAt)}
									</td>
									<td className="px-4 py-3 text-sm text-text-secondary">
										{formatRelativeTime(task.updatedAt)}
									</td>
								</tr>
								{expandedTaskId === task.id && (
									<TaskExpandedRow
										key={`${task.id}-expanded`}
										task={task}
									/>
								)}
							</>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
