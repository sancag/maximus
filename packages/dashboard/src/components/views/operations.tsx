"use client";

import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { useStore } from "@/hooks/use-store";
import { EventCard } from "@/components/shared/event-card";
import { FilterChips } from "@/components/shared/filter-chips";
import { EmptyState } from "@/components/shared/empty-state";

export function OperationsView() {
	const events = useStore((s) => s.events);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
	const [agentFilter, setAgentFilter] = useState("");

	const eventTypes = useMemo(() => {
		const types = new Set<string>();
		for (const e of events) {
			types.add(e.type);
		}
		return Array.from(types).sort();
	}, [events]);

	const filteredEvents = useMemo(() => {
		return events.filter((event) => {
			if (typeFilter.size > 0 && !typeFilter.has(event.type)) return false;
			if (
				agentFilter &&
				!event.agentName.toLowerCase().includes(agentFilter.toLowerCase())
			)
				return false;
			return true;
		});
	}, [events, typeFilter, agentFilter]);

	const handleTypeToggle = (type: string) => {
		setTypeFilter((prev) => {
			const next = new Set(prev);
			if (next.has(type)) {
				next.delete(type);
			} else {
				next.add(type);
			}
			return next;
		});
	};

	if (events.length === 0 && typeFilter.size === 0 && !agentFilter) {
		return (
			<EmptyState
				icon={Activity}
				heading="No Activity Yet"
				body="Agent events will appear here in real-time once a mission is running."
			/>
		);
	}

	return (
		<div className="flex h-full flex-col p-6">
			<div className="mb-4 flex flex-wrap items-center gap-4">
				<FilterChips
					options={eventTypes}
					selected={typeFilter}
					onToggle={handleTypeToggle}
					label="Type"
				/>
				<input
					type="text"
					placeholder="Filter by agent..."
					value={agentFilter}
					onChange={(e) => setAgentFilter(e.target.value)}
					className="w-48 rounded border border-border bg-surface px-3 py-1 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
				/>
			</div>

			<div className="flex flex-1 flex-col gap-2 overflow-y-auto">
				{filteredEvents.length === 0 ? (
					<p className="py-8 text-center text-sm text-text-secondary">
						No events match filters
					</p>
				) : (
					filteredEvents.map((event) => (
						<EventCard
							key={event.id}
							event={event}
							expanded={expandedId === event.id}
							onToggle={() =>
								setExpandedId((prev) =>
									prev === event.id ? null : event.id,
								)
							}
						/>
					))
				)}
			</div>
		</div>
	);
}
