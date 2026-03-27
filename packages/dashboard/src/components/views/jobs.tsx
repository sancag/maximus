"use client";

import { useState, useEffect, useCallback } from "react";
import { CalendarClock, Play, Pencil, Trash2, Plus, X, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn, formatRelativeTime } from "@/lib/utils";
import { EmptyState } from "@/components/shared/empty-state";

// --- Types (mirrors server scheduler/types.ts) ---

interface JobRun {
	runId: string;
	jobId: string;
	startedAt: number;
	completedAt?: number;
	success?: boolean;
	output?: string;
	error?: string;
}

interface JobState {
	lastRun?: number;
	nextRun?: number;
	runCount: number;
	lastStatus?: "success" | "failed" | "running";
	recentRuns: JobRun[];
}

interface Job {
	id: string;
	name: string;
	type: "agent" | "pipeline";
	agent?: string;
	prompt?: string;
	schedule: string;
	enabled: boolean;
	timezone?: string;
	maxConcurrent: number;
	state: JobState;
}

type FormData = {
	id: string;
	name: string;
	agent: string;
	prompt: string;
	schedule: string;
	enabled: boolean;
	timezone: string;
	maxConcurrent: number;
};

const EMPTY_FORM: FormData = {
	id: "",
	name: "",
	agent: "",
	prompt: "",
	schedule: "",
	enabled: true,
	timezone: "",
	maxConcurrent: 1,
};

// --- Helpers ---

function formatDuration(startedAt: number, completedAt?: number): string {
	if (!completedAt) return "—";
	const ms = completedAt - startedAt;
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

const STATUS_CLASSES: Record<"success" | "failed" | "running", { text: string; bg: string }> = {
	success: { text: "text-success", bg: "bg-success/10" },
	failed: { text: "text-destructive", bg: "bg-destructive/10" },
	running: { text: "text-warning", bg: "bg-warning/10" },
};

// --- Sub-components ---

function StatusBadge({ status }: { status?: "success" | "failed" | "running" }) {
	if (!status) return <span className="text-xs text-text-secondary">—</span>;
	const cls = STATUS_CLASSES[status];
	return (
		<span className={cn("text-xs px-2 py-0.5 rounded font-medium", cls.text, cls.bg)}>
			{status}
		</span>
	);
}

function RunsTable({ runs }: { runs: JobRun[] }) {
	if (runs.length === 0) {
		return <p className="text-xs text-text-secondary">No runs recorded yet.</p>;
	}
	return (
		<table className="w-full text-xs">
			<thead>
				<tr className="text-text-secondary uppercase tracking-wider">
					<th className="text-left pb-1 pr-4 font-medium">Run ID</th>
					<th className="text-left pb-1 pr-4 font-medium">Started</th>
					<th className="text-left pb-1 pr-4 font-medium">Duration</th>
					<th className="text-left pb-1 pr-4 font-medium">Status</th>
					<th className="text-left pb-1 font-medium">Output / Error</th>
				</tr>
			</thead>
			<tbody>
				{runs.map((run) => (
					<tr key={run.runId} className="border-t border-border/50">
						<td className="py-1 pr-4 font-mono text-text-secondary">
							{run.runId.slice(0, 8)}
						</td>
						<td className="py-1 pr-4 text-text-primary">
							{formatRelativeTime(run.startedAt)}
						</td>
						<td className="py-1 pr-4 text-text-primary">
							{formatDuration(run.startedAt, run.completedAt)}
						</td>
						<td className="py-1 pr-4">
							{run.success === undefined ? (
								<span className="text-warning">running</span>
							) : run.success ? (
								<span className="text-success">success</span>
							) : (
								<span className="text-destructive">failed</span>
							)}
						</td>
						<td className="py-1 text-text-secondary max-w-xs truncate">
							{run.error ?? run.output ?? "—"}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function JobExpandedRow({ job }: { job: Job }) {
	return (
		<tr>
			<td colSpan={8} className="px-4 py-0">
				<div className="bg-elevated p-4 rounded mb-2 space-y-3">
					<div className="grid grid-cols-2 gap-4 text-sm">
						<div>
							<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
								Schedule
							</span>
							<p className="text-text-primary mt-1 font-mono">{job.schedule}</p>
						</div>
						{job.timezone && (
							<div>
								<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
									Timezone
								</span>
								<p className="text-text-primary mt-1">{job.timezone}</p>
							</div>
						)}
						{job.agent && (
							<div>
								<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
									Agent
								</span>
								<p className="text-text-primary mt-1">{job.agent}</p>
							</div>
						)}
						<div>
							<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
								Max Concurrent
							</span>
							<p className="text-text-primary mt-1">{job.maxConcurrent}</p>
						</div>
					</div>
					{job.prompt && (
						<div>
							<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
								Prompt
							</span>
							<p className="text-sm text-text-primary mt-1 whitespace-pre-wrap">{job.prompt}</p>
						</div>
					)}
					<div>
						<span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
							Recent Runs ({job.state.recentRuns.length})
						</span>
						<div className="mt-2">
							<RunsTable runs={job.state.recentRuns.slice().reverse()} />
						</div>
					</div>
				</div>
			</td>
		</tr>
	);
}

// --- Job Form Modal ---

function JobModal({
	initial,
	onSave,
	onClose,
	saving,
	error,
}: {
	initial?: Job;
	onSave: (data: FormData) => void;
	onClose: () => void;
	saving: boolean;
	error: string | null;
}) {
	const [form, setForm] = useState<FormData>(
		initial
			? {
					id: initial.id,
					name: initial.name,
					agent: initial.agent ?? "",
					prompt: initial.prompt ?? "",
					schedule: initial.schedule,
					enabled: initial.enabled,
					timezone: initial.timezone ?? "",
					maxConcurrent: initial.maxConcurrent,
				}
			: EMPTY_FORM,
	);

	const isEdit = !!initial;

	const set = (field: keyof FormData, value: unknown) =>
		setForm((f) => ({ ...f, [field]: value }));

	const labelCls = "block text-xs font-medium text-text-secondary uppercase tracking-wider mb-1";
	const inputCls =
		"w-full bg-dominant border border-border rounded px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary outline-none focus:border-accent transition-colors";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="bg-surface border border-border rounded-lg w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
				<div className="flex items-center justify-between px-5 py-4 border-b border-border">
					<h2 className="text-sm font-semibold text-text-primary">
						{isEdit ? "Edit Job" : "New Job"}
					</h2>
					<button type="button" onClick={onClose} className="text-text-secondary hover:text-text-primary">
						<X size={16} />
					</button>
				</div>

				<div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
					{!isEdit && (
						<div>
							<label className={labelCls}>ID</label>
							<input
								className={inputCls}
								value={form.id}
								onChange={(e) => set("id", e.target.value)}
								placeholder="my-daily-report"
							/>
							<p className="text-xs text-text-secondary mt-1">
								Lowercase letters, numbers, hyphens. Cannot be changed after creation.
							</p>
						</div>
					)}

					<div>
						<label className={labelCls}>Name</label>
						<input
							className={inputCls}
							value={form.name}
							onChange={(e) => set("name", e.target.value)}
							placeholder="Daily report"
						/>
					</div>

					<div>
						<label className={labelCls}>Schedule (cron)</label>
						<input
							className={cn(inputCls, "font-mono")}
							value={form.schedule}
							onChange={(e) => set("schedule", e.target.value)}
							placeholder="0 9 * * *"
						/>
						<p className="text-xs text-text-secondary mt-1">
							Standard cron: minute hour day month weekday
						</p>
					</div>

					<div>
						<label className={labelCls}>Agent</label>
						<input
							className={inputCls}
							value={form.agent}
							onChange={(e) => set("agent", e.target.value)}
							placeholder="researcher"
						/>
					</div>

					<div>
						<label className={labelCls}>Prompt</label>
						<textarea
							className={cn(inputCls, "resize-none")}
							rows={4}
							value={form.prompt}
							onChange={(e) => set("prompt", e.target.value)}
							placeholder="Run the daily analytics report and post results to Slack."
						/>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div>
							<label className={labelCls}>Timezone (optional)</label>
							<input
								className={inputCls}
								value={form.timezone}
								onChange={(e) => set("timezone", e.target.value)}
								placeholder="America/New_York"
							/>
						</div>
						<div>
							<label className={labelCls}>Max Concurrent</label>
							<input
								type="number"
								min={1}
								max={10}
								className={inputCls}
								value={form.maxConcurrent}
								onChange={(e) => set("maxConcurrent", Number(e.target.value))}
							/>
						</div>
					</div>

					<div className="flex items-center gap-3">
						<button
							type="button"
							role="switch"
							aria-checked={form.enabled}
							onClick={() => set("enabled", !form.enabled)}
							className={cn(
								"relative w-9 h-5 rounded-full transition-colors",
								form.enabled ? "bg-accent" : "bg-border",
							)}
						>
							<span
								className={cn(
									"absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform",
									form.enabled ? "translate-x-4" : "translate-x-0.5",
								)}
							/>
						</button>
						<span className="text-sm text-text-primary">Enabled</span>
					</div>

					{error && (
						<p className="text-sm text-destructive">{error}</p>
					)}
				</div>

				<div className="flex justify-end gap-2 px-5 py-4 border-t border-border">
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => onSave(form)}
						disabled={saving}
						className="px-4 py-1.5 text-sm bg-accent text-white rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
					>
						{saving ? "Saving…" : isEdit ? "Save Changes" : "Create Job"}
					</button>
				</div>
			</div>
		</div>
	);
}

// --- Delete confirmation ---

function DeleteConfirm({
	job,
	onConfirm,
	onCancel,
}: {
	job: Job;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div className="bg-surface border border-border rounded-lg w-80 p-5 space-y-4">
				<h2 className="text-sm font-semibold text-text-primary">Delete Job</h2>
				<p className="text-sm text-text-secondary">
					Delete <span className="text-text-primary font-medium">{job.name}</span>? This cannot be undone.
				</p>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						className="px-4 py-1.5 text-sm bg-destructive text-white rounded hover:bg-destructive/90 transition-colors"
					>
						Delete
					</button>
				</div>
			</div>
		</div>
	);
}

// --- Main view ---

export function JobsView() {
	const [jobs, setJobs] = useState<Job[]>([]);
	const [loading, setLoading] = useState(true);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [modal, setModal] = useState<null | "create" | Job>(null);
	const [deleteTarget, setDeleteTarget] = useState<Job | null>(null);
	const [modalSaving, setModalSaving] = useState(false);
	const [modalError, setModalError] = useState<string | null>(null);
	const [triggering, setTriggering] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const data = await api.getJobs();
			setJobs(data.jobs as Job[]);
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	async function handleSave(form: FormData) {
		setModalSaving(true);
		setModalError(null);
		try {
			const payload: Record<string, unknown> = {
				name: form.name,
				type: "agent",
				schedule: form.schedule,
				enabled: form.enabled,
				maxConcurrent: form.maxConcurrent,
			};
			if (form.agent) payload.agent = form.agent;
			if (form.prompt) payload.prompt = form.prompt;
			if (form.timezone) payload.timezone = form.timezone;

			let res: Response;
			if (modal === "create") {
				payload.id = form.id;
				res = await api.createJob(payload);
			} else {
				res = await api.updateJob((modal as Job).id, payload);
			}

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
			}

			setModal(null);
			await load();
		} catch (err) {
			setModalError(err instanceof Error ? err.message : String(err));
		} finally {
			setModalSaving(false);
		}
	}

	async function handleDelete(job: Job) {
		await api.deleteJob(job.id);
		setDeleteTarget(null);
		await load();
	}

	async function handleTrigger(id: string) {
		setTriggering(id);
		try {
			await api.triggerJob(id);
			// Brief delay then reload to pick up the new run
			setTimeout(() => void load(), 1500);
		} finally {
			setTriggering(null);
		}
	}

	const thCls = "text-xs font-medium text-text-secondary uppercase tracking-wider px-4 py-3 text-left";

	if (loading) {
		return (
			<div className="flex items-center justify-center h-full text-text-secondary text-sm">
				Loading jobs…
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			{/* Toolbar */}
			<div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
				<span className="text-xs text-text-secondary">{jobs.length} job{jobs.length !== 1 ? "s" : ""}</span>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={() => void load()}
						className="p-1.5 text-text-secondary hover:text-text-primary transition-colors"
						title="Refresh"
					>
						<RefreshCw size={14} />
					</button>
					<button
						type="button"
						onClick={() => { setModalError(null); setModal("create"); }}
						className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent text-white rounded hover:bg-accent/90 transition-colors"
					>
						<Plus size={13} />
						New Job
					</button>
				</div>
			</div>

			{jobs.length === 0 ? (
				<div className="flex-1 flex items-center justify-center">
					<EmptyState
						icon={CalendarClock}
						heading="No Scheduled Jobs"
						body="Create a job to run an agent on a cron schedule."
					/>
				</div>
			) : (
				<div className="flex-1 overflow-auto">
					<table className="w-full">
						<thead className="bg-surface sticky top-0 z-10">
							<tr>
								<th className={cn(thCls, "w-8")} />
								<th className={thCls}>Name</th>
								<th className={thCls}>Schedule</th>
								<th className={thCls}>Status</th>
								<th className={thCls}>Last Run</th>
								<th className={thCls}>Next Run</th>
								<th className={thCls}>Runs</th>
								<th className={cn(thCls, "text-right")}>Actions</th>
							</tr>
						</thead>
						<tbody>
							{jobs.map((job) => {
								const isExpanded = expandedId === job.id;
								const isPipeline = job.type === "pipeline";
								return (
									<>
										<tr
											key={job.id}
											className={cn(
												"border-t border-border cursor-pointer hover:bg-elevated transition-colors",
												isExpanded && "bg-elevated",
											)}
											onClick={() => setExpandedId(isExpanded ? null : job.id)}
										>
											<td className="px-4 py-3 text-text-secondary">
												{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
											</td>
											<td className="px-4 py-3">
												<div className="flex items-center gap-2">
													<span className="text-sm text-text-primary font-medium">{job.name}</span>
													{isPipeline && (
														<span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent">
															pipeline
														</span>
													)}
													{!job.enabled && (
														<span className="text-xs px-1.5 py-0.5 rounded bg-border text-text-secondary">
															disabled
														</span>
													)}
												</div>
												<div className="text-xs text-text-secondary mt-0.5 font-mono">{job.id}</div>
											</td>
											<td className="px-4 py-3 text-sm font-mono text-text-secondary">
												{job.schedule}
											</td>
											<td className="px-4 py-3">
												<StatusBadge status={job.state.lastStatus} />
											</td>
											<td className="px-4 py-3 text-sm text-text-secondary">
												{job.state.lastRun ? formatRelativeTime(job.state.lastRun) : "—"}
											</td>
											<td className="px-4 py-3 text-sm text-text-secondary">
												{job.state.nextRun ? formatRelativeTime(job.state.nextRun) : "—"}
											</td>
											<td className="px-4 py-3 text-sm text-text-secondary">
												{job.state.runCount}
											</td>
											<td
												className="px-4 py-3 text-right"
												onClick={(e) => e.stopPropagation()}
											>
												<div className="flex items-center justify-end gap-1">
													<button
														type="button"
														title="Run now"
														disabled={triggering === job.id}
														onClick={() => void handleTrigger(job.id)}
														className="p-1.5 text-text-secondary hover:text-success transition-colors disabled:opacity-40"
													>
														<Play size={13} />
													</button>
													{!isPipeline && (
														<>
															<button
																type="button"
																title="Edit"
																onClick={() => { setModalError(null); setModal(job); }}
																className="p-1.5 text-text-secondary hover:text-text-primary transition-colors"
															>
																<Pencil size={13} />
															</button>
															<button
																type="button"
																title="Delete"
																onClick={() => setDeleteTarget(job)}
																className="p-1.5 text-text-secondary hover:text-destructive transition-colors"
															>
																<Trash2 size={13} />
															</button>
														</>
													)}
												</div>
											</td>
										</tr>
										{isExpanded && (
											<JobExpandedRow key={`${job.id}-expanded`} job={job} />
										)}
									</>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{modal !== null && (
				<JobModal
					initial={modal === "create" ? undefined : (modal as Job)}
					onSave={handleSave}
					onClose={() => setModal(null)}
					saving={modalSaving}
					error={modalError}
				/>
			)}

			{deleteTarget && (
				<DeleteConfirm
					job={deleteTarget}
					onConfirm={() => void handleDelete(deleteTarget)}
					onCancel={() => setDeleteTarget(null)}
				/>
			)}
		</div>
	);
}
