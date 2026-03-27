# Mission Control Dashboard

Maximus's Mission Control is a JARVIS-inspired dashboard for monitoring and interacting with your agent teams in real-time.

## Overview

The Mission Control dashboard provides four core views: an **Operations** activity feed for real-time event monitoring, an **Org Chart** showing agent hierarchy, a **Chat** interface for sending messages to your orchestrator, and a **Tasks** table tracking all delegated work. The dashboard connects to the Maximus server via REST API (for initial state sync) and WebSocket (for real-time event streaming).

The dashboard is a Next.js application built with React 19, Zustand for state management, and Tailwind CSS v4 for styling. Client-side view routing is managed through Zustand state rather than URL routes.

## Layout

The shell consists of three regions:

- **Header bar** (fixed, top): Displays the Maximus branding, active agent count, running task count, and a WebSocket connection status indicator dot (green = connected, amber pulsing = reconnecting, red = disconnected). When reconnecting, a banner reading "Reconnecting to server..." appears below the header.
- **Sidebar** (fixed, left): A narrow 48px icon rail with four navigation buttons -- Operations (`Activity` icon), Org Chart (`Network` icon), Chat (`MessageCircle` icon), and Tasks (`ListChecks` icon). The active view is highlighted with an accent color and a left-edge accent bar. Icons are sourced from `lucide-react`.
- **Content area**: The active view fills the remaining space to the right of the sidebar and below the header.

## Views

### Operations

The Operations view (`OperationsView` component) displays a real-time activity feed of agent events.

- **Event timeline**: Events are displayed newest-first in a scrollable list. Each event is rendered as an `EventCard` showing: a colored icon, the agent name, an event summary, and a relative timestamp (e.g., "2m ago").
- **12 event types** with distinct icons and colors:

| Event Type | Icon | Color |
|---|---|---|
| `agent:message` | MessageSquare | accent (cyan) |
| `agent:tool_call` | Wrench | warning (amber) |
| `agent:tool_result` | CheckCircle | success (green) |
| `agent:delegation` | Send | accent (cyan) |
| `agent:completion` | CheckCheck | success (green) |
| `agent:error` | AlertTriangle | destructive (red) |
| `session:start` | Play | success (green) |
| `session:end` | Square | secondary (gray) |
| `task:created` | PlusCircle | accent (cyan) |
| `task:assigned` | UserCheck | accent (cyan) |
| `task:completed` | CircleCheckBig | success (green) |
| `task:failed` | XCircle | destructive (red) |

- **Filter by event type**: Use the `FilterChips` component to toggle event types on and off. Only events matching selected types are shown.
- **Filter by agent name**: Type into the text input to filter events by agent name (case-insensitive substring match).
- **Expand event details**: Click any event card to expand it and see the full payload as formatted JSON.
- **Real-time delivery**: Events arrive via WebSocket and are prepended to the store (capped at 500 events via the `useStore` Zustand store).

### Org Chart

The Org Chart view (`OrgChartView` component) displays a top-down tree layout of your agent hierarchy.

- **Tree layout**: Built with CSS flexbox (not SVG or canvas) for simplicity and accessibility. The orchestrator sits at the top, managers below, and workers at the bottom.
- **Agent nodes**: Each node (`AgentNode` component) shows the agent's name, a status badge (idle, active, or error), and the current task prompt (if in-progress).
- **Status derivation**: Agent status is derived by scanning the last 100 events newest-first. The first status-determining event per agent wins: `session:start` = active, `session:end` = idle, `agent:error` = error.
- **Active agent highlighting**: Active agents have a glowing accent-colored border on their node.
- **Connection lines**: Vertical and horizontal lines connect parent to children, showing reporting relationships. When a recent delegation event exists between two agents, the connection line glows with an accent shadow effect.
- **Detail panel**: Click any agent node to open a slide-out panel on the right side showing:
  - Agent description
  - Skills list (fetched from REST API on demand)
  - Recent activity (last 5 events for that agent, with icons and timestamps)
  - Active tasks (in-progress or assigned tasks with truncated prompts)
- Click outside the panel or the X button to close it.

### Chat

The Chat view (`ChatView` component) provides a direct messaging interface to the orchestrator agent.

- **Send messages**: Type in the textarea at the bottom and press Enter to send. The message is routed to the orchestrator (the agent with no `reportsTo` field). Press Shift+Enter to insert a newline without sending.
- **Streaming responses**: Agent responses stream in real-time via Server-Sent Events (SSE). Chunks arrive as `data:` lines with `{"type":"chunk","content":"..."}` payloads and are concatenated into the assistant message using an updater function pattern for safe streaming.
- **Markdown rendering**: Assistant messages are rendered with `react-markdown`, supporting code blocks (with syntax-highlighted `<pre>` wrappers), inline code, lists, and links.
- **Streaming indicator**: While a response is streaming, the message bubble has a glow shadow effect (`shadow-[var(--glow-accent-strong)]`) and a pulsing cursor bar appears after the text.
- **Auto-scroll**: The message list auto-scrolls to the bottom when new messages arrive.
- **Send button**: Disabled while input is empty or a response is actively streaming.

### Tasks

The Tasks view (`TasksView` component) displays all tasks in a sortable, filterable table.

- **Table columns**: Task ID, Agent, Status, Trace ID, Created, Updated.
- **Sortable columns**: Click any column header (except Trace ID) to toggle ascending/descending sort. A chevron indicator shows the current sort direction.
- **Filters**:
  - Filter by agent name (text input, case-insensitive substring)
  - Filter by trace ID (text input, case-insensitive substring)
  - Filter by status (dropdown: All, created, assigned, in-progress, completed, failed)
- **Status badges**: Color-coded pill badges for each status:

| Status | Color |
|---|---|
| created | gray (text-secondary) |
| assigned | cyan (accent) |
| in-progress | amber (warning) |
| completed | green (success) |
| failed | red (destructive) |

- **Expand row details**: Click any row to expand it and see: full prompt text, parent task ID, result or error (depending on status), and token usage count.

## Connection Handling

The dashboard manages the WebSocket connection automatically via the `useWebSocket` hook.

- **Auto-connect**: On page load, the dashboard opens a WebSocket connection to the server.
- **Connection status indicator**: The header displays a colored dot:
  - Green dot = connected
  - Amber pulsing dot = reconnecting
  - Red dot = disconnected
- **Reconnection with exponential backoff**: On disconnect, the dashboard automatically attempts to reconnect. The initial delay is 1 second, doubling with each attempt (1s, 2s, 4s, 8s, 16s...), capped at a maximum of 30 seconds between attempts.
- **Reconnecting banner**: While reconnecting, a banner reading "Reconnecting to server..." appears below the header with a warning color background.
- **State resync on reconnect**: When the WebSocket reconnects, the `syncState` function fires, fetching the full agent list and task list from the REST API (`/api/org-chart` and `/api/tasks`). This ensures the dashboard state is current after any gap in WebSocket delivery.
- **No user action required**: The entire reconnection flow is fully automatic. The event store (capped at 500 events) continues accumulating events once the connection is restored.

## Configuration

The dashboard reads two environment variables at build time:

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | Base URL for the Maximus REST API server |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:3000/ws` | WebSocket endpoint for real-time event streaming |

Set these in a `.env.local` file in `packages/dashboard/` or export them before building.

## Running the Dashboard

```bash
# Development (assumes server running on port 3000)
cd packages/dashboard
pnpm dev  # Starts on port 3001 with Turbopack

# Production build
pnpm build
pnpm start  # Starts on port 3001
```

Open [http://localhost:3001](http://localhost:3001) in your browser. The dashboard defaults to the Operations view.
