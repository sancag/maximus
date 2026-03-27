"use client";

import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
	icon: LucideIcon;
	heading: string;
	body: string;
}

export function EmptyState({ icon: Icon, heading, body }: EmptyStateProps) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center">
			<Icon size={48} className="text-text-secondary opacity-50" />
			<h2 className="mt-4 text-lg font-semibold text-text-secondary">
				{heading}
			</h2>
			<p className="mt-2 max-w-md text-center text-sm text-text-secondary">
				{body}
			</p>
		</div>
	);
}
