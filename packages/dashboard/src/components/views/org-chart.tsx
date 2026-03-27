"use client";

import {
	useState,
	useMemo,
	useEffect,
	useCallback,
	useRef,
} from "react";
import { Network, X } from "lucide-react";
import type { AgentEvent } from "@maximus/shared";
import { useStore } from "@/hooks/use-store";
import { cn, formatRelativeTime, truncateId } from "@/lib/utils";
import { EVENT_CONFIG } from "@/lib/constants";
import { api } from "@/lib/api";
import { EmptyState } from "@/components/shared/empty-state";
import { SkeletonOrgChart } from "@/components/shared/skeleton";

type AgentStatus = "idle" | "active" | "error";

interface TreeNode {
	name: string;
	reportsTo?: string;
	description: string;
	children: TreeNode[];
}

interface AgentDetail {
	name: string;
	description: string;
	model: string;
	reportsTo?: string;
	skills: string[];
}

interface CanvasNode {
	name: string;
	x: number;
	y: number;
	radius: number;
	status: AgentStatus;
	isRoot: boolean;
	depth: number;
	currentTask?: string;
	description: string;
}

interface CanvasEdge {
	from: string;
	to: string;
	active: boolean;
}

/* ─── Palette ─── */
const GOLD = "#d4a020";
const GOLD_BRIGHT = "#f0c040";
const GOLD_DIM = "#8a6a10";
const AMBER = "#ff9800";
const BG = "#06060a";

/* ─── Helpers ─── */
function buildTree(
	agents: Array<{ name: string; reportsTo?: string; description: string }>,
): TreeNode[] {
	const nodeMap = new Map<string, TreeNode>();
	for (const a of agents) {
		nodeMap.set(a.name, { ...a, children: [] });
	}
	const roots: TreeNode[] = [];
	for (const node of nodeMap.values()) {
		if (node.reportsTo && nodeMap.has(node.reportsTo)) {
			nodeMap.get(node.reportsTo)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	return roots;
}

function deriveAgentStatuses(events: AgentEvent[]): Map<string, AgentStatus> {
	const statusMap = new Map<string, AgentStatus>();
	const recent = events.slice(0, 100);
	const seen = new Set<string>();
	for (const event of recent) {
		if (seen.has(event.agentName)) continue;
		if (event.type === "session:start") {
			statusMap.set(event.agentName, "active");
			seen.add(event.agentName);
		} else if (event.type === "session:end") {
			statusMap.set(event.agentName, "idle");
			seen.add(event.agentName);
		} else if (event.type === "agent:error") {
			statusMap.set(event.agentName, "error");
			seen.add(event.agentName);
		}
	}
	return statusMap;
}

function getActiveDelegations(events: AgentEvent[]): Set<string> {
	const delegations = new Set<string>();
	const recent = events.slice(0, 50);
	for (const event of recent) {
		if (event.type === "agent:delegation") {
			const toAgent = event.payload.toAgent as string | undefined;
			if (toAgent) {
				delegations.add(`${event.agentName}->${toAgent}`);
			}
		}
	}
	return delegations;
}

/* ─── Layout: place nodes in concentric rings ─── */
function layoutNodes(
	tree: TreeNode[],
	statuses: Map<string, AgentStatus>,
	currentTasks: Map<string, string>,
	cx: number,
	cy: number,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];

	// Find the primary root (maximus) — treat it as the center
	const mainRoot = tree.find((n) => n.name === "maximus") ?? tree[0];
	const otherRoots = tree.filter((n) => n !== mainRoot);

	if (!mainRoot) return { nodes, edges };

	// Center node
	nodes.push({
		name: mainRoot.name,
		x: cx,
		y: cy,
		radius: 52,
		status: statuses.get(mainRoot.name) ?? "idle",
		isRoot: true,
		depth: 0,
		currentTask: currentTasks.get(mainRoot.name),
		description: mainRoot.description,
	});

	// Collect all level-1 children (from main root + other roots count as level 1)
	const level1: TreeNode[] = [...mainRoot.children, ...otherRoots];

	// Ring 1 — level-1 agents
	const ring1Radius = 300;
	const ring1Count = level1.length;
	const ring1Start = -Math.PI / 2; // Start from top

	for (let i = 0; i < ring1Count; i++) {
		const child = level1[i];
		const angle = ring1Start + ((2 * Math.PI) / ring1Count) * i;
		const nx = cx + Math.cos(angle) * ring1Radius;
		const ny = cy + Math.sin(angle) * ring1Radius;

		nodes.push({
			name: child.name,
			x: nx,
			y: ny,
			radius: 40,
			status: statuses.get(child.name) ?? "idle",
			isRoot: false,
			depth: 1,
			currentTask: currentTasks.get(child.name),
			description: child.description,
		});

		// Edge from center to level-1
		const parentName = child.reportsTo && tree.some((r) => r.name !== mainRoot.name && r === child)
			? mainRoot.name // other roots connect to main root visually
			: mainRoot.name;
		edges.push({ from: parentName, to: child.name, active: false });

		// Ring 2 — level-2 agents (children of level-1)
		if (child.children.length > 0) {
			const ring2Radius = 200;
			const spread = Math.min(
				(2 * Math.PI) / ring1Count * 0.8,
				(child.children.length - 1) * 0.4 + 0.4,
			);
			const childStart = angle - spread / 2;

			for (let j = 0; j < child.children.length; j++) {
				const grandchild = child.children[j];
				const childAngle =
					child.children.length === 1
						? angle
						: childStart + (spread / (child.children.length - 1)) * j;
				const gx = nx + Math.cos(childAngle) * ring2Radius;
				const gy = ny + Math.sin(childAngle) * ring2Radius;

				nodes.push({
					name: grandchild.name,
					x: gx,
					y: gy,
					radius: 30,
					status: statuses.get(grandchild.name) ?? "idle",
					isRoot: false,
					depth: 2,
					currentTask: currentTasks.get(grandchild.name),
					description: grandchild.description,
				});

				edges.push({ from: child.name, to: grandchild.name, active: false });
			}
		}
	}

	return { nodes, edges };
}

/* ─── Particle along edge ─── */
interface Particle {
	edge: number; // index into edges
	t: number; // 0..1 position along edge
	speed: number;
}

function initParticles(edgeCount: number): Particle[] {
	const particles: Particle[] = [];
	for (let i = 0; i < edgeCount; i++) {
		// 2 particles per edge at different positions
		particles.push({ edge: i, t: Math.random(), speed: 0.002 + Math.random() * 0.003 });
		particles.push({ edge: i, t: Math.random(), speed: 0.001 + Math.random() * 0.002 });
	}
	return particles;
}

/* ─── Canvas Renderer ─── */
function JarvisCanvas({
	nodes,
	edges,
	activeDelegations,
	onNodeClick,
	hoveredNode,
	setHoveredNode,
}: {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	activeDelegations: Set<string>;
	onNodeClick: (name: string) => void;
	hoveredNode: string | null;
	setHoveredNode: (name: string | null) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const animRef = useRef<number>(0);
	const particlesRef = useRef<Particle[]>([]);
	const timeRef = useRef(0);
	const transformRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
	const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number }>({
		dragging: false,
		lastX: 0,
		lastY: 0,
	});

	// Responsive sizing
	const [size, setSize] = useState({ w: 0, h: 0 });
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const { width, height } = entries[0].contentRect;
			setSize({ w: width, h: height });
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Initialize particles when edges change
	useEffect(() => {
		particlesRef.current = initParticles(edges.length);
	}, [edges.length]);

	// Node lookup for edges
	const nodeMap = useMemo(() => {
		const m = new Map<string, CanvasNode>();
		for (const n of nodes) m.set(n.name, n);
		return m;
	}, [nodes]);

	// Animation loop
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || size.w === 0) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		canvas.width = size.w * dpr;
		canvas.height = size.h * dpr;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		function draw() {
			if (!ctx) return;
			const t = transformRef.current;
			timeRef.current += 1;
			const time = timeRef.current;

			ctx.clearRect(0, 0, size.w, size.h);
			ctx.save();
			ctx.translate(size.w / 2 + t.offsetX, size.h / 2 + t.offsetY);
			ctx.scale(t.scale, t.scale);
			ctx.translate(-size.w / 2, -size.h / 2);

			// ── Background decorative rings ──
			const cx = size.w / 2;
			const cy = size.h / 2;
			for (let r = 150; r <= 700; r += 110) {
				ctx.beginPath();
				ctx.arc(cx, cy, r, 0, Math.PI * 2);
				ctx.strokeStyle = `rgba(212, 160, 32, ${0.04 - r * 0.00006})`;
				ctx.lineWidth = 0.5;
				ctx.stroke();
			}

			// ── Rotating dashed rings ──
			for (let ri = 0; ri < 3; ri++) {
				const ringR = 220 + ri * 160;
				const rotSpeed = (ri % 2 === 0 ? 1 : -1) * 0.001;
				ctx.save();
				ctx.translate(cx, cy);
				ctx.rotate(time * rotSpeed);
				ctx.beginPath();
				ctx.arc(0, 0, ringR, 0, Math.PI * 2);
				ctx.strokeStyle = `rgba(212, 160, 32, ${0.06 - ri * 0.015})`;
				ctx.setLineDash([4, 12 + ri * 4]);
				ctx.lineWidth = 0.5;
				ctx.stroke();
				ctx.setLineDash([]);
				ctx.restore();
			}

			// ── Edges ──
			for (const edge of edges) {
				const fromN = nodeMap.get(edge.from);
				const toN = nodeMap.get(edge.to);
				if (!fromN || !toN) continue;

				const isActive = activeDelegations.has(`${edge.from}->${edge.to}`);
				const alpha = isActive ? 0.7 : 0.2;

				ctx.beginPath();
				ctx.moveTo(fromN.x, fromN.y);
				ctx.lineTo(toN.x, toN.y);
				ctx.strokeStyle = isActive
					? `rgba(240, 192, 64, ${alpha})`
					: `rgba(212, 160, 32, ${alpha})`;
				ctx.lineWidth = isActive ? 1.5 : 0.8;
				ctx.stroke();

				// Glow on active edges
				if (isActive) {
					ctx.beginPath();
					ctx.moveTo(fromN.x, fromN.y);
					ctx.lineTo(toN.x, toN.y);
					ctx.strokeStyle = "rgba(240, 192, 64, 0.15)";
					ctx.lineWidth = 6;
					ctx.stroke();
				}
			}

			// ── Particles along edges ──
			for (const p of particlesRef.current) {
				p.t += p.speed;
				if (p.t > 1) p.t -= 1;

				const edge = edges[p.edge];
				if (!edge) continue;
				const fromN = nodeMap.get(edge.from);
				const toN = nodeMap.get(edge.to);
				if (!fromN || !toN) continue;

				const px = fromN.x + (toN.x - fromN.x) * p.t;
				const py = fromN.y + (toN.y - fromN.y) * p.t;

				const isActive = activeDelegations.has(`${edge.from}->${edge.to}`);
				const pAlpha = isActive ? 0.8 : 0.3;
				const pSize = isActive ? 2.5 : 1.5;

				ctx.beginPath();
				ctx.arc(px, py, pSize, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(240, 192, 64, ${pAlpha})`;
				ctx.fill();
			}

			// ── Nodes ──
			for (const node of nodes) {
				const isHovered = hoveredNode === node.name;
				const isActive = node.status === "active";
				const isError = node.status === "error";

				// Outer glow
				const glowSize = node.isRoot ? 35 : 18;
				const pulse = Math.sin(time * 0.03) * 0.3 + 0.7;
				const glowAlpha = isError
					? 0.2
					: node.isRoot
						? 0.15 * pulse
						: isActive
							? 0.12 * pulse
							: 0.04;

				const gradient = ctx.createRadialGradient(
					node.x,
					node.y,
					node.radius * 0.5,
					node.x,
					node.y,
					node.radius + glowSize,
				);

				const glowColor = isError
					? "255, 68, 102"
					: isActive
						? "240, 192, 64"
						: "212, 160, 32";

				gradient.addColorStop(0, `rgba(${glowColor}, ${glowAlpha * 2})`);
				gradient.addColorStop(1, `rgba(${glowColor}, 0)`);

				ctx.beginPath();
				ctx.arc(node.x, node.y, node.radius + glowSize, 0, Math.PI * 2);
				ctx.fillStyle = gradient;
				ctx.fill();

				// Node circle fill — tinted red for errors
				const fillGradient = ctx.createRadialGradient(
					node.x - node.radius * 0.3,
					node.y - node.radius * 0.3,
					0,
					node.x,
					node.y,
					node.radius,
				);

				if (isError) {
					fillGradient.addColorStop(0, "rgba(60, 12, 18, 0.95)");
					fillGradient.addColorStop(0.7, "rgba(35, 8, 12, 0.95)");
					fillGradient.addColorStop(1, "rgba(20, 5, 8, 0.95)");
				} else if (node.isRoot) {
					fillGradient.addColorStop(0, "rgba(40, 30, 8, 0.95)");
					fillGradient.addColorStop(0.7, "rgba(20, 15, 4, 0.95)");
					fillGradient.addColorStop(1, "rgba(12, 10, 3, 0.95)");
				} else {
					fillGradient.addColorStop(0, "rgba(25, 22, 15, 0.9)");
					fillGradient.addColorStop(1, "rgba(12, 10, 5, 0.9)");
				}

				ctx.beginPath();
				ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
				ctx.fillStyle = fillGradient;
				ctx.fill();

				// Border ring — red for error, bright gold for active, dim for idle
				const borderAlpha = isHovered ? 0.9 : isError ? 0.8 : isActive ? 0.7 : 0.25;
				ctx.beginPath();
				ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
				ctx.strokeStyle = isError
					? `rgba(255, 68, 102, ${borderAlpha})`
					: isActive
						? `rgba(240, 192, 64, ${borderAlpha})`
						: `rgba(138, 106, 16, ${borderAlpha})`;
				ctx.lineWidth = node.isRoot ? 2.5 : isError ? 2 : isHovered ? 1.5 : 1;
				ctx.stroke();

				// Root: secondary inner ring
				if (node.isRoot) {
					ctx.beginPath();
					ctx.arc(node.x, node.y, node.radius - 6, 0, Math.PI * 2);
					ctx.strokeStyle = `rgba(240, 192, 64, ${0.15 * pulse})`;
					ctx.lineWidth = 0.5;
					ctx.stroke();

					// Spinning arc segments for root
					for (let seg = 0; seg < 3; seg++) {
						const segAngle = (time * 0.01) + (seg * Math.PI * 2) / 3;
						ctx.beginPath();
						ctx.arc(
							node.x,
							node.y,
							node.radius + 8,
							segAngle,
							segAngle + 0.4,
						);
						ctx.strokeStyle = `rgba(240, 192, 64, ${0.3 * pulse})`;
						ctx.lineWidth = 1.5;
						ctx.stroke();
					}
				}

				// Error: pulsing red inner ring
				if (isError) {
					ctx.beginPath();
					ctx.arc(node.x, node.y, node.radius - 4, 0, Math.PI * 2);
					ctx.strokeStyle = `rgba(255, 68, 102, ${0.25 * pulse})`;
					ctx.lineWidth = 1;
					ctx.stroke();
				}

				// Label
				ctx.font = node.isRoot
					? "600 14px Inter, sans-serif"
					: node.depth === 1
						? "500 12px Inter, sans-serif"
						: "400 11px Inter, sans-serif";
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillStyle = isError
					? "#ff8899"
					: isHovered
						? GOLD_BRIGHT
						: node.isRoot
							? "#e8d8a0"
							: "#c0b090";
				ctx.fillText(node.name, node.x, node.y);

				// Current task below node
				if (node.currentTask && node.depth < 2) {
					ctx.font = "400 9px Inter, sans-serif";
					ctx.fillStyle = "rgba(180, 160, 120, 0.6)";
					const taskText =
						node.currentTask.length > 28
							? node.currentTask.slice(0, 28) + "..."
							: node.currentTask;
					ctx.fillText(taskText, node.x, node.y + node.radius + 16);
				}
			}

			ctx.restore();
			animRef.current = requestAnimationFrame(draw);
		}

		animRef.current = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(animRef.current);
	}, [nodes, edges, nodeMap, activeDelegations, hoveredNode, size]);

	// ── Mouse interaction ──
	const screenToWorld = useCallback(
		(sx: number, sy: number) => {
			const t = transformRef.current;
			const wx = (sx - size.w / 2 - t.offsetX) / t.scale + size.w / 2;
			const wy = (sy - size.h / 2 - t.offsetY) / t.scale + size.h / 2;
			return { x: wx, y: wy };
		},
		[size],
	);

	const hitTestNode = useCallback(
		(sx: number, sy: number): CanvasNode | null => {
			const { x, y } = screenToWorld(sx, sy);
			// Check in reverse (top-most nodes first)
			for (let i = nodes.length - 1; i >= 0; i--) {
				const n = nodes[i];
				const dx = x - n.x;
				const dy = y - n.y;
				if (dx * dx + dy * dy <= (n.radius + 8) * (n.radius + 8)) {
					return n;
				}
			}
			return null;
		},
		[nodes, screenToWorld],
	);

	const handleWheel = useCallback((e: React.WheelEvent) => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? 0.92 : 1.08;
		const t = transformRef.current;
		const newScale = Math.max(0.3, Math.min(3, t.scale * delta));
		transformRef.current = { ...t, scale: newScale };
	}, []);

	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
	}, []);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			const rect = canvasRef.current?.getBoundingClientRect();
			if (!rect) return;
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;

			if (dragRef.current.dragging) {
				const dx = e.clientX - dragRef.current.lastX;
				const dy = e.clientY - dragRef.current.lastY;
				dragRef.current.lastX = e.clientX;
				dragRef.current.lastY = e.clientY;
				transformRef.current.offsetX += dx;
				transformRef.current.offsetY += dy;
				return;
			}

			const node = hitTestNode(sx, sy);
			setHoveredNode(node ? node.name : null);

			if (canvasRef.current) {
				canvasRef.current.style.cursor = node ? "pointer" : "grab";
			}
		},
		[hitTestNode, setHoveredNode],
	);

	const handleMouseUp = useCallback(() => {
		dragRef.current.dragging = false;
	}, []);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			const rect = canvasRef.current?.getBoundingClientRect();
			if (!rect) return;
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			const node = hitTestNode(sx, sy);
			if (node) onNodeClick(node.name);
		},
		[hitTestNode, onNodeClick],
	);

	return (
		<div ref={containerRef} className="absolute inset-0" style={{ background: BG }}>
			<canvas
				ref={canvasRef}
				style={{ width: size.w, height: size.h }}
				onWheel={handleWheel}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onClick={handleClick}
			/>
			{/* Zoom hint */}
			<div className="absolute bottom-4 left-4 text-xs text-[#8a6a10] select-none pointer-events-none">
				Scroll to zoom · Drag to pan
			</div>
		</div>
	);
}

/* ─── Detail Panel ─── */
function DetailPanel({
	agentName,
	agents,
	events,
	tasks,
	agentDetails,
	onClose,
}: {
	agentName: string;
	agents: Array<{ name: string; reportsTo?: string; description: string }>;
	events: AgentEvent[];
	tasks: Array<{
		id: string;
		agentName: string;
		status: string;
		prompt: string;
	}>;
	agentDetails: AgentDetail | null;
	onClose: () => void;
}) {
	const agent = agents.find((a) => a.name === agentName);
	const recentEvents = events
		.filter((e) => e.agentName === agentName)
		.slice(0, 5);
	const activeTasks = tasks.filter(
		(t) =>
			t.agentName === agentName &&
			(t.status === "in-progress" || t.status === "assigned"),
	);

	return (
		<div className="fixed top-0 right-0 w-80 h-full bg-[#0c0a05]/95 backdrop-blur-md border-l border-[#2a2210] p-6 z-30 overflow-y-auto">
			<button
				type="button"
				onClick={onClose}
				className="absolute top-4 right-4 text-[#8a6a10] hover:text-[#f0c040] transition-colors"
			>
				<X size={18} />
			</button>

			<div className="text-lg font-semibold text-[#e8d8a0]">{agentName}</div>
			{agent && (
				<div className="text-sm text-[#8a6a10] mt-1">{agent.description}</div>
			)}

			{/* Status */}
			<div className="mt-4">
				<h4 className="text-xs font-medium text-[#8a6a10] uppercase tracking-wider mb-2">
					Status
				</h4>
				<span className="inline-flex items-center gap-1.5 rounded-full border border-[#d4a020]/30 px-2.5 py-0.5 text-xs text-[#d4a020]">
					<span className="w-1.5 h-1.5 rounded-full bg-[#00ff88]" />
					{recentEvents.length > 0 ? "active" : "idle"}
				</span>
			</div>

			{/* Model */}
			{agentDetails?.model && (
				<div className="mt-4">
					<h4 className="text-xs font-medium text-[#8a6a10] uppercase tracking-wider mb-2">
						Model
					</h4>
					<span className="rounded-full border border-[#2a2210] px-2.5 py-0.5 text-xs text-[#c0a060]">
						{agentDetails.model}
					</span>
				</div>
			)}

			{/* Skills */}
			{agentDetails?.skills && agentDetails.skills.length > 0 && (
				<div className="mt-4">
					<h4 className="text-xs font-medium text-[#8a6a10] uppercase tracking-wider mb-2">
						Skills
					</h4>
					<div className="flex flex-wrap gap-1.5">
						{agentDetails.skills.map((skill) => (
							<span
								key={skill}
								className="rounded-full border border-[#2a2210] px-2 py-0.5 text-xs text-[#8a6a10]"
							>
								{skill}
							</span>
						))}
					</div>
				</div>
			)}

			{/* Recent Activity */}
			<div className="mt-4">
				<h4 className="text-xs font-medium text-[#8a6a10] uppercase tracking-wider mb-2">
					Recent Activity
				</h4>
				{recentEvents.length === 0 ? (
					<p className="text-xs text-[#5a4a20]">No recent activity</p>
				) : (
					<div className="flex flex-col gap-2">
						{recentEvents.map((event) => {
							const config = EVENT_CONFIG[event.type as keyof typeof EVENT_CONFIG];
							if (!config) return null;
							const Icon = config.icon;
							return (
								<div
									key={event.id}
									className="flex items-center gap-2 text-xs"
								>
									<Icon size={14} style={{ color: GOLD }} />
									<span className="text-[#c0a060] truncate flex-1">
										{event.type}
									</span>
									<span className="text-[#5a4a20] whitespace-nowrap">
										{formatRelativeTime(event.timestamp)}
									</span>
								</div>
							);
						})}
					</div>
				)}
			</div>

			{/* Active Tasks */}
			<div className="mt-4">
				<h4 className="text-xs font-medium text-[#8a6a10] uppercase tracking-wider mb-2">
					Active Tasks
				</h4>
				{activeTasks.length === 0 ? (
					<p className="text-xs text-[#5a4a20]">No active tasks</p>
				) : (
					<div className="flex flex-col gap-2">
						{activeTasks.map((task) => (
							<div
								key={task.id}
								className="rounded border border-[#2a2210] bg-[#0f0d08] p-2"
							>
								<div className="font-mono text-xs text-[#5a4a20]">
									{truncateId(task.id)}
								</div>
								<div className="text-xs text-[#c0a060] mt-1 truncate">
									{task.prompt.length > 60
										? `${task.prompt.slice(0, 60)}...`
										: task.prompt}
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/* ─── Main Export ─── */
export function OrgChartView() {
	const agents = useStore((s) => s.agents);
	const events = useStore((s) => s.events);
	const tasks = useStore((s) => s.tasks);
	const connectionStatus = useStore((s) => s.connectionStatus);

	const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
	const [hoveredNode, setHoveredNode] = useState<string | null>(null);
	const [agentDetails, setAgentDetails] = useState<AgentDetail[]>([]);
	const panelRef = useRef<HTMLDivElement>(null);

	const agentStatuses = useMemo(() => deriveAgentStatuses(events), [events]);
	const activeDelegations = useMemo(
		() => getActiveDelegations(events),
		[events],
	);
	const currentTasks = useMemo(() => {
		const map = new Map<string, string>();
		for (const task of tasks) {
			if (task.status === "in-progress") {
				map.set(task.agentName, task.prompt);
			}
		}
		return map;
	}, [tasks]);

	const tree = useMemo(() => buildTree(agents), [agents]);

	// Layout nodes
	const { nodes, edges } = useMemo(() => {
		// Use a fixed center — the canvas handles viewport transform
		return layoutNodes(tree, agentStatuses, currentTasks, 640, 400);
	}, [tree, agentStatuses, currentTasks]);

	// Fetch full agent details when panel opens
	useEffect(() => {
		if (selectedAgent && agentDetails.length === 0) {
			api.getAgents().then((res) => setAgentDetails(res.agents)).catch(() => {});
		}
	}, [selectedAgent, agentDetails.length]);

	// Close panel on outside click
	const handleOutsideClick = useCallback(
		(e: MouseEvent) => {
			if (
				selectedAgent &&
				panelRef.current &&
				!panelRef.current.contains(e.target as Node)
			) {
				setSelectedAgent(null);
			}
		},
		[selectedAgent],
	);

	useEffect(() => {
		if (selectedAgent) {
			document.addEventListener("mousedown", handleOutsideClick);
			return () => document.removeEventListener("mousedown", handleOutsideClick);
		}
	}, [selectedAgent, handleOutsideClick]);

	if (agents.length === 0 && connectionStatus === "connecting") {
		return <SkeletonOrgChart />;
	}

	if (agents.length === 0) {
		return (
			<EmptyState
				icon={Network}
				heading="No Agents Registered"
				body="Register agents with the server to see your org chart here."
			/>
		);
	}

	const selectedDetail =
		agentDetails.find((d) => d.name === selectedAgent) || null;

	return (
		<div className="relative h-full overflow-hidden">
			<JarvisCanvas
				nodes={nodes}
				edges={edges}
				activeDelegations={activeDelegations}
				onNodeClick={setSelectedAgent}
				hoveredNode={hoveredNode}
				setHoveredNode={setHoveredNode}
			/>

			{selectedAgent && (
				<div ref={panelRef}>
					<DetailPanel
						agentName={selectedAgent}
						agents={agents}
						events={events}
						tasks={tasks}
						agentDetails={selectedDetail}
						onClose={() => setSelectedAgent(null)}
					/>
				</div>
			)}
		</div>
	);
}
