import type { TaskStatus } from "@maximus/shared";

export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
	created: ["assigned"],
	assigned: ["in-progress"],
	"in-progress": ["completed", "failed"],
	completed: [],
	failed: [],
};

export function validateTransition(
	from: TaskStatus,
	to: TaskStatus,
): boolean {
	return VALID_TRANSITIONS[from].includes(to);
}
