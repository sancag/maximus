"use client";

import { useStore } from "@/hooks/use-store";

function MaximusLogo({ size = 22 }: { size?: number }) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			width={size}
			height={size}
		>
			<rect fill="#0b0b0b" x="0" y="0" width="32" height="32" rx="7" />
			<line stroke="#C4851A" fill="none" strokeWidth="0.5" x1="16" y1="2.5" x2="27.5" y2="9" />
			<line stroke="#C4851A" fill="none" strokeWidth="0.5" x1="27.5" y1="11" x2="27.5" y2="21" />
			<line stroke="#C4851A" fill="none" strokeWidth="0.5" x1="27.5" y1="23" x2="16" y2="29.5" />
			<line stroke="#C4851A" fill="none" strokeWidth="0.5" x1="4.5" y1="23" x2="16" y2="29.5" />
			<line stroke="#C4851A" fill="none" strokeWidth="0.5" x1="4.5" y1="11" x2="4.5" y2="21" />
			<line stroke="#C4851A" fill="none" strokeWidth="0.5" x1="4.5" y1="9" x2="16" y2="2.5" />
			<circle fill="#E8A422" cx="16" cy="2.5" r="1.1" />
			<circle fill="#C4851A" cx="27.5" cy="10" r="1.1" />
			<circle fill="#C4851A" cx="27.5" cy="22" r="1.1" />
			<circle fill="#C4851A" cx="16" cy="29.5" r="1.1" />
			<circle fill="#C4851A" cx="4.5" cy="22" r="1.1" />
			<circle fill="#C4851A" cx="4.5" cy="10" r="1.1" />
			<polyline stroke="#E8A422" fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" points="7,23 7,9 16,17 25,9 25,23" />
			<circle fill="#E8A422" cx="7" cy="23" r="1.4" />
			<circle fill="#E8A422" cx="25" cy="23" r="1.4" />
			<circle fill="#E8A422" cx="16" cy="17" r="1.6" />
		</svg>
	);
}

export function Header() {
	const connectionStatus = useStore((s) => s.connectionStatus);
	const agents = useStore((s) => s.agents);
	const tasks = useStore((s) => s.tasks);

	const runningTasks = tasks.filter((t) => t.status === "in-progress").length;

	return (
		<>
			<header className="fixed top-0 left-0 right-0 h-12 bg-surface border-b border-border z-50 flex items-center justify-between px-4">
				<div className="flex items-center gap-4">
					<div className="pl-12 flex items-center gap-2">
						<MaximusLogo />
						<span className="text-sm font-semibold text-accent">
							Maximus
						</span>
					</div>
					<span className="flex items-center gap-1.5 text-xs text-text-secondary">
						<span className="w-1.5 h-1.5 rounded-full bg-accent" />
						{agents.length} agents active
					</span>
				</div>

				<div className="flex items-center gap-4">
					<span className="flex items-center gap-1.5 text-xs text-text-secondary">
						<span className="w-1.5 h-1.5 rounded-full bg-accent" />
						{runningTasks} tasks running
					</span>
					<span
						className={`w-2 h-2 rounded-full ${
							connectionStatus === "connected"
								? "bg-success"
								: connectionStatus === "reconnecting"
									? "bg-warning animate-[pulse-dot_1500ms_ease-in-out_infinite]"
									: "bg-destructive"
						}`}
						title={
							connectionStatus === "connected"
								? "Connected"
								: connectionStatus === "reconnecting"
									? "Reconnecting..."
									: connectionStatus === "connecting"
										? "Connecting"
										: "Disconnected"
						}
					/>
				</div>
			</header>

			{connectionStatus === "reconnecting" && (
				<div className="fixed top-12 left-0 right-0 z-50 px-4 py-1.5 text-xs text-warning bg-[rgba(255,170,0,0.1)] text-center">
					Reconnecting to server...
				</div>
			)}
		</>
	);
}
