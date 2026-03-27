"use client";

import { cn } from "@/lib/utils";

interface FilterChipsProps {
	options: string[];
	selected: Set<string>;
	onToggle: (value: string) => void;
	label?: string;
}

export function FilterChips({
	options,
	selected,
	onToggle,
	label,
}: FilterChipsProps) {
	return (
		<div className="flex items-center gap-2 overflow-x-auto">
			{label && (
				<span className="mr-2 text-xs text-text-secondary">{label}</span>
			)}
			{options.map((option) => {
				const isActive = selected.has(option);
				return (
					<button
						key={option}
						type="button"
						onClick={() => onToggle(option)}
						className={cn(
							"rounded-full border px-3 py-1 text-xs transition-colors duration-150",
							isActive
								? "border-accent bg-accent/10 text-accent"
								: "border-border bg-surface text-text-secondary hover:bg-elevated hover:text-text-primary",
						)}
					>
						{option}
					</button>
				);
			})}
		</div>
	);
}
