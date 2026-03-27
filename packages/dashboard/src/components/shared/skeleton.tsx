"use client";

export function SkeletonOrgChart() {
	return (
		<div className="flex flex-col items-center gap-16 p-8">
			{/* Top node */}
			<div className="w-[200px] h-[80px] rounded-lg bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite]" />
			{/* Two child nodes */}
			<div className="flex items-start gap-12 justify-center">
				<div className="w-[200px] h-[80px] rounded-lg bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite]" />
				<div className="w-[200px] h-[80px] rounded-lg bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite]" />
			</div>
		</div>
	);
}

export function SkeletonOperations() {
	return (
		<div className="flex flex-col gap-3 p-4">
			{Array.from({ length: 5 }).map((_, i) => (
				<div
					key={i}
					className="w-full h-12 rounded-lg bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite]"
				/>
			))}
		</div>
	);
}

export function SkeletonChat() {
	return (
		<div className="flex flex-col gap-3 p-4">
			{Array.from({ length: 3 }).map((_, i) => (
				<div
					key={i}
					className={`h-10 rounded-lg bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite] ${
						i % 2 === 0
							? "w-3/5 self-start"
							: "w-2/5 self-end"
					}`}
				/>
			))}
		</div>
	);
}

export function SkeletonTasks() {
	return (
		<div className="flex flex-col gap-0 p-4">
			{/* Header */}
			<div className="w-full h-10 rounded-t-lg bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite]" />
			{/* Rows */}
			{Array.from({ length: 5 }).map((_, i) => (
				<div
					key={i}
					className="w-full h-12 border-t border-border bg-elevated animate-[skeleton-pulse_800ms_ease-in-out_infinite]"
				/>
			))}
		</div>
	);
}
