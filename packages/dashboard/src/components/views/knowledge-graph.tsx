"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { useStore } from "@/hooks/use-store";
import type { KnowledgeGraphResponse } from "@maximus/shared";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

const SCOPE_COLORS: Record<string, string> = {
	agent: "#3B82F6",   // blue
	team: "#F59E0B",    // amber
	global: "#10B981",  // emerald
};

const SCOPE_OPTIONS = ["all", "agent", "team", "global"] as const;

export function KnowledgeGraphView() {
	const storeGraph = useStore((s) => s.memoryGraph);
	const [graphData, setGraphData] = useState<KnowledgeGraphResponse | null>(null);
	const [scopeFilter, setScopeFilter] = useState<string>("all");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
	const containerRef = useRef<HTMLDivElement>(null);
	const initialLoadDone = useRef(false);

	useEffect(() => {
		// On first render with "all" scope, use pre-fetched store data if available
		if (!initialLoadDone.current && scopeFilter === "all" && storeGraph) {
			setGraphData(storeGraph);
			setLoading(false);
			initialLoadDone.current = true;
			return;
		}
		initialLoadDone.current = true;
		setLoading(true);
		api.getMemoryGraph(scopeFilter)
			.then((data) => { setGraphData(data); setError(null); })
			.catch((err) => setError(err.message))
			.finally(() => setLoading(false));
	}, [scopeFilter, storeGraph]);

	useEffect(() => {
		const updateDimensions = () => {
			if (containerRef.current) {
				const rect = containerRef.current.getBoundingClientRect();
				setDimensions({ width: rect.width, height: rect.height });
			}
		};

		updateDimensions();
		window.addEventListener("resize", updateDimensions);
		return () => window.removeEventListener("resize", updateDimensions);
	}, []);

	return (
		<div className="flex flex-col h-full">
			{/* Header bar */}
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-lg font-semibold text-text-primary">Knowledge Graph</h2>
				<div className="flex items-center gap-4">
					{graphData && (
						<span className="text-sm text-text-secondary">
							{graphData.counts.entities} entities, {graphData.counts.triples} triples
						</span>
					)}
					<select
						value={scopeFilter}
						onChange={(e) => setScopeFilter(e.target.value)}
						className="bg-surface border border-border rounded px-2 py-1 text-sm text-text-primary"
					>
						{SCOPE_OPTIONS.map((scope) => (
							<option key={scope} value={scope}>
								{scope === "all" ? "All scopes" : `${scope.charAt(0).toUpperCase() + scope.slice(1)} scope`}
							</option>
						))}
					</select>
				</div>
			</div>

			{/* Legend */}
			<div className="flex gap-4 mb-2">
				{Object.entries(SCOPE_COLORS).map(([scope, color]) => (
					<span key={scope} className="flex items-center gap-1 text-xs text-text-secondary">
						<span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: color }} />
						{scope}
					</span>
				))}
			</div>

			{/* Graph container */}
			<div
				ref={containerRef}
				className="flex-1 bg-surface rounded border border-border overflow-hidden"
			>
				{loading && (
					<div className="flex items-center justify-center h-full text-text-secondary">
						Loading...
					</div>
				)}
				{error && (
					<div className="flex items-center justify-center h-full text-red-400">
						Error: {error}
					</div>
				)}
				{!loading && !error && graphData && graphData.nodes.length === 0 && (
					<div className="flex items-center justify-center h-full text-text-secondary">
						No knowledge entities yet
					</div>
				)}
				{!loading && !error && graphData && graphData.nodes.length > 0 && (
					<ForceGraph2D
						graphData={{ nodes: graphData.nodes, links: graphData.links }}
						nodeLabel="name"
						nodeAutoColorBy="type"
						nodeVal={3}
						linkLabel="predicate"
						linkColor={(link: any) => SCOPE_COLORS[link.scope] ?? "#666"}
						linkDirectionalArrowLength={4}
						linkDirectionalArrowRelPos={1}
						backgroundColor="transparent"
						width={dimensions.width}
						height={dimensions.height}
						cooldownTicks={100}
					/>
				)}
			</div>
		</div>
	);
}
