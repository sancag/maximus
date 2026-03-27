import type { LucideIcon } from "lucide-react";
import {
	MessageSquare,
	Wrench,
	CheckCircle,
	Send,
	CheckCheck,
	AlertTriangle,
	Play,
	Square,
	PlusCircle,
	UserCheck,
	CircleCheckBig,
	XCircle,
	Briefcase,
} from "lucide-react";
import type { AgentEventType, TaskStatus } from "@maximus/shared";

export const EVENT_CONFIG: Record<
	AgentEventType,
	{ icon: LucideIcon; color: string }
> = {
	"agent:message": { icon: MessageSquare, color: "var(--color-accent)" },
	"agent:tool_call": { icon: Wrench, color: "var(--color-warning)" },
	"agent:tool_result": { icon: CheckCircle, color: "var(--color-success)" },
	"agent:delegation": { icon: Send, color: "var(--color-accent)" },
	"agent:completion": { icon: CheckCheck, color: "var(--color-success)" },
	"agent:error": { icon: AlertTriangle, color: "var(--color-destructive)" },
	"session:start": { icon: Play, color: "var(--color-success)" },
	"session:end": { icon: Square, color: "var(--color-text-secondary)" },
	"task:created": { icon: PlusCircle, color: "var(--color-accent)" },
	"task:assigned": { icon: UserCheck, color: "var(--color-accent)" },
	"task:completed": { icon: CircleCheckBig, color: "var(--color-success)" },
	"task:failed": { icon: XCircle, color: "var(--color-destructive)" },
	"job:started": { icon: Briefcase, color: "var(--color-accent)" },
	"job:completed": { icon: CircleCheckBig, color: "var(--color-success)" },
	"job:failed": { icon: XCircle, color: "var(--color-destructive)" },
};

export const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
	created: "var(--color-text-secondary)",
	assigned: "var(--color-accent)",
	"in-progress": "var(--color-warning)",
	completed: "var(--color-success)",
	failed: "var(--color-destructive)",
};
