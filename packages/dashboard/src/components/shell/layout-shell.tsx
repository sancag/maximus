"use client";

import { useStore } from "@/hooks/use-store";
import { Header } from "./header";
import { Sidebar } from "./sidebar";
import type { ViewType } from "@/types";
import { OperationsView } from "@/components/views/operations";
import { OrgChartView } from "@/components/views/org-chart";
import { ChatView } from "@/components/views/chat";
import { TasksView } from "@/components/views/tasks";
import { KnowledgeGraphView } from "@/components/views/knowledge-graph";
import { AgentMemoryView } from "@/components/views/agent-memory";
import { JobsView } from "@/components/views/jobs";

const views: Record<ViewType, () => React.JSX.Element> = {
	operations: OperationsView,
	"org-chart": OrgChartView,
	chat: ChatView,
	tasks: TasksView,
	"knowledge-graph": KnowledgeGraphView,
	"agent-memory": AgentMemoryView,
	jobs: JobsView,
};

export function LayoutShell() {
	const activeView = useStore((s) => s.activeView);
	const View = views[activeView];

	return (
		<div className="h-screen bg-dominant text-text-primary">
			<Header />
			<Sidebar />
			<main className="ml-12 mt-12 h-[calc(100vh-48px)] p-6">
				<View />
			</main>
		</div>
	);
}
