"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/hooks/use-store";
import type { AgentMemoryResponse, MemoryStatusResponse } from "@maximus/shared";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";

export function AgentMemoryView() {
	const storeAgents = useStore((s) => s.memoryAgents);
	const [agents, setAgents] = useState<Array<{ agentName: string; count: number }>>([]);
	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [agentData, setAgentData] = useState<AgentMemoryResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Use pre-fetched store agents if available, otherwise fetch from API
	useEffect(() => {
		if (storeAgents.length > 0) {
			setAgents(storeAgents);
			return;
		}
		api.getMemoryStatus()
			.then((status: MemoryStatusResponse) => setAgents(status.episodes.byAgent))
			.catch(() => setAgents([]));
	}, [storeAgents]);

	// Agent selection handler
	const handleSelectAgent = useCallback((agentName: string) => {
		setSelectedAgent(agentName);
		setLoading(true);
		api.getAgentMemory(agentName)
			.then((data) => { setAgentData(data); setError(null); })
			.catch((err) => setError(err.message))
			.finally(() => setLoading(false));
	}, []);

	return (
		<div className="flex h-full">
			{/* Left sidebar: Agent list */}
			<div className="w-48 border-r border-border pr-4 overflow-y-auto">
				<h3 className="text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">Agents</h3>
				{agents.length === 0 && <p className="text-xs text-text-secondary">No agents with memory</p>}
				{agents.map((a) => (
					<button
						key={a.agentName}
						onClick={() => handleSelectAgent(a.agentName)}
						className={cn(
							"w-full text-left px-2 py-1.5 rounded text-sm transition-colors",
							selectedAgent === a.agentName ? "bg-elevated text-accent" : "text-text-primary hover:bg-elevated"
						)}
					>
						<span>{a.agentName}</span>
						<span className="text-text-secondary text-xs ml-1">({a.count})</span>
					</button>
				))}
			</div>

			{/* Right content area */}
			<div className="flex-1 pl-4 overflow-y-auto">
				{!selectedAgent && (
					<div className="flex items-center justify-center h-full text-text-secondary">
						Select an agent to view memory
					</div>
				)}

				{selectedAgent && loading && (
					<div className="flex items-center justify-center h-full text-text-secondary">
						Loading...
					</div>
				)}

				{selectedAgent && error && (
					<div className="flex items-center justify-center h-full text-red-400">
						Error: {error}
					</div>
				)}

				{selectedAgent && agentData && (
					<div className="space-y-6">
						{/* Episodes section */}
						<div>
							<h3 className="text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
								Episodes ({agentData.episodes.length})
							</h3>
							<div className="space-y-2 max-h-64 overflow-y-auto">
								{agentData.episodes.map((ep) => (
									<div key={ep.id} className="bg-surface border border-border rounded p-2 text-sm">
										<div className="flex justify-between">
											<span className="font-medium">
												{ep.taskDescription.slice(0, 60)}{ep.taskDescription.length > 60 ? "..." : ""}
											</span>
											<span
												className={cn(
													"text-xs px-1.5 py-0.5 rounded",
													ep.outcome === "success" ? "bg-green-500/20 text-green-400" :
													ep.outcome === "failure" ? "bg-red-500/20 text-red-400" : "bg-yellow-500/20 text-yellow-400"
												)}
											>
												{ep.outcome}
											</span>
										</div>
										<div className="text-xs text-text-secondary mt-1">
											{new Date(ep.timestamp).toLocaleString()}
										</div>
										{ep.lessonsLearned.length > 0 && (
											<div className="text-xs text-text-secondary mt-1">
												Lessons: {ep.lessonsLearned.join(", ")}
											</div>
										)}
									</div>
								))}
								{agentData.episodes.length === 0 && (
									<p className="text-xs text-text-secondary">No episodes recorded</p>
								)}
							</div>
						</div>

						{/* Metrics section */}
						{agentData.metrics.length > 0 && (
							<div>
								<h3 className="text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">Metrics</h3>
								<div className="bg-surface border border-border rounded p-3 h-48">
									<ResponsiveContainer width="100%" height="100%">
										<LineChart
											data={agentData.metrics.map((m) => ({
												date: new Date(m.timestamp).toLocaleDateString(),
												successRate: m.successRate != null ? Math.round(m.successRate * 100) : null,
												avgTurns: m.avgTurns,
											}))}
										>
											<XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#666" />
											<YAxis tick={{ fontSize: 10 }} stroke="#666" />
											<Tooltip contentStyle={{ backgroundColor: "#1a1a2e", border: "1px solid #333" }} />
											<Line type="monotone" dataKey="successRate" stroke="#10B981" name="Success %" dot={false} />
											<Line type="monotone" dataKey="avgTurns" stroke="#3B82F6" name="Avg Turns" dot={false} />
										</LineChart>
									</ResponsiveContainer>
								</div>
							</div>
						)}

						{/* Briefing section */}
						<div>
							<h3 className="text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">Active Briefing</h3>
							{agentData.briefing ? (
								<div className="bg-surface border border-border rounded p-3 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
									{agentData.briefing.content}
								</div>
							) : (
								<p className="text-xs text-text-secondary">No briefing generated yet</p>
							)}
						</div>

						{/* Knowledge section */}
						<div>
							<h3 className="text-sm font-semibold text-text-secondary mb-2 uppercase tracking-wide">
								Knowledge ({agentData.knowledge.length})
							</h3>
							<div className="space-y-1 max-h-48 overflow-y-auto">
								{agentData.knowledge.map((k, i) => (
									<div
										key={i}
										className="flex items-center gap-2 text-xs bg-surface border border-border rounded px-2 py-1"
									>
										<span className="font-medium">{k.entity.name}</span>
										<span className="text-text-secondary">{k.triple.predicate}</span>
										<span className="font-medium">{k.target.name}</span>
										<span
											className={cn(
												"ml-auto px-1 py-0.5 rounded text-[10px]",
												k.triple.scope === "global" ? "bg-emerald-500/20 text-emerald-400" :
												k.triple.scope === "team" ? "bg-amber-500/20 text-amber-400" : "bg-blue-500/20 text-blue-400"
											)}
										>
											{k.triple.scope}
										</span>
									</div>
								))}
								{agentData.knowledge.length === 0 && (
									<p className="text-xs text-text-secondary">No knowledge in scope</p>
								)}
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
