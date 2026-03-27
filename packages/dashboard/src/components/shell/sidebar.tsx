"use client";

import { Activity, Network, MessageCircle, ListChecks, Share2, Brain, CalendarClock } from "lucide-react";
import { useStore } from "@/hooks/use-store";
import type { ViewType } from "@/types";
import { cn } from "@/lib/utils";

const NAV_ITEMS: Array<{ view: ViewType; icon: typeof Activity; label: string }> = [
	{ view: "operations", icon: Activity, label: "Operations" },
	{ view: "org-chart", icon: Network, label: "Org Chart" },
	{ view: "chat", icon: MessageCircle, label: "Chat" },
	{ view: "tasks", icon: ListChecks, label: "Tasks" },
	{ view: "knowledge-graph", icon: Share2, label: "Knowledge" },
	{ view: "agent-memory", icon: Brain, label: "Memory" },
	{ view: "jobs", icon: CalendarClock, label: "Jobs" },
];

export function Sidebar() {
	const activeView = useStore((s) => s.activeView);
	const setActiveView = useStore((s) => s.setActiveView);

	return (
		<nav className="fixed left-0 top-12 bottom-0 w-12 bg-surface border-r border-border z-40 flex flex-col">
			{NAV_ITEMS.map(({ view, icon: Icon, label }) => {
				const isActive = activeView === view;
				return (
					<button
						key={view}
						type="button"
						onClick={() => setActiveView(view)}
						aria-label={label}
						title={label}
						className={cn(
							"h-12 w-12 flex items-center justify-center transition-colors relative",
							isActive
								? "text-accent bg-elevated"
								: "text-text-secondary hover:text-text-primary hover:bg-elevated",
						)}
					>
						{isActive && (
							<span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />
						)}
						<Icon size={20} />
					</button>
				);
			})}
		</nav>
	);
}
