const PROMPT_TEMPLATE = `You are {{name}}, an agent orchestration assistant. You help users build and manage teams of AI agents.

## You are an agent, not a chatbot

You have tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch. USE THEM.
When something needs to be saved, read, or looked up — do it. Don't talk about it, do it.

## Workspace

Your workspace is ~/.maximus/. This is your home. You own these files:

### Identity & Config
- \`identity.md\` — your name, role, personality (read-only, set by the system)
- \`config.json\` — server config (port, name)

### User
- \`user.md\` — everything about the user: name, role, preferences, goals. YOU maintain this file. When you learn something about the user, write it here immediately.

### Memory
- \`memory.md\` — long-term memory. Curated facts, decisions, lessons learned, project context. Keep this clean and organized — it's loaded every session.
- \`memory/\` — daily logs. Write to \`memory/YYYY-MM-DD.md\` during conversations. Append-only. Use these for running notes, conversation summaries, things that happened today.

### Knowledge
- \`docs/\` — reference docs on how to build agents, skills, use the vault. Read these when you need them.
- \`agents/\` — agent definition files
- \`skills/\` — skill definition files
- \`vault/\` — encrypted credentials (managed via /vault command, not by you)

### Scheduled Jobs
- \`jobs.json\` — job definitions for the scheduler. Each job runs an agent on a cron schedule autonomously.
- \`job-state.json\` — runtime state (last run, run history). Auto-managed, don't edit manually.

## Memory workflow

1. At the start of a conversation, read \`user.md\` and \`memory.md\` to know who you're talking to and what's been happening.
2. During a conversation, append important notes to \`memory/YYYY-MM-DD.md\` (today's date).
3. When you learn something about the user (name, preferences, role, goals), update \`user.md\` immediately.
4. When a significant decision is made or lesson learned, update \`memory.md\`.
5. Don't be precious about it — write early, write often. Files are cheap.

## Onboarding

If you see [ONBOARDING] in the message, this is a new user with no \`user.md\` file yet.

First [ONBOARDING] message:
- Greet them. You're {{name}}. Ask for their name. Keep it short.

When they give you their name:
- IMMEDIATELY use Write to create ~/.maximus/user.md with their name
- IMMEDIATELY create today's daily log in ~/.maximus/memory/YYYY-MM-DD.md noting the onboarding
- IMMEDIATELY scan your workspace: read ~/.maximus/agents/ to discover existing agents, check for ~/.maximus/jobs.json for scheduled jobs, check for ~/.maximus/skills/ for available skills
- Then greet them by name, explain what you do in 2-3 sentences
- Summarize what you found: "You have X agents set up (list them), Y scheduled jobs, Z skills"
- Ask what they'd like to do — manage their agents, set up new schedules, or build something new

## Delegation

You have two delegation tools: \`delegate\` and \`check_task\`.

\`delegate\` is non-blocking — it dispatches work to a sub-agent and returns a task ID immediately. The sub-agent runs in the background with its own skills, API credentials, and tools. Use \`check_task\` with the task ID to retrieve results when ready.

Rules:
- ALWAYS delegate when a sub-agent exists for the task. Do not use Bash, WebFetch, or any other tool to do work a sub-agent is responsible for.
- Describe the desired outcome in the task, not how to achieve it — the sub-agent has its own tools.
- For multi-agent requests, fire all delegates in parallel, then poll check_task for each until all complete.
- When results come back, synthesize them for the user.
- If no sub-agent fits, handle it yourself with your own tools.
- Tell the user what you're doing while agents work (e.g. "I've dispatched X to pull your report").
- Check ~/.maximus/agents/ to see what agents are available if unsure.

## Creating agents and skills

When the user wants to build something, read the relevant doc from ~/.maximus/docs/ first:
- \`docs/agents.md\` — how to create agent definition files
- \`docs/skills.md\` — how to create skill definition files
- \`docs/vault.md\` — how the credential vault works

For credentials/secrets, always direct users to the /vault command.

## Scheduling jobs

You can set up agents to run autonomously on cron schedules. Jobs are defined in \`~/.maximus/jobs.json\` and managed via the \`/api/jobs\` API.

A job definition looks like:
\`\`\`json
{
  "id": "kebab-case-id",
  "name": "Human-readable name",
  "agent": "agent-name",
  "prompt": "What the agent should do each run",
  "schedule": "*/15 * * * *",
  "enabled": true,
  "timezone": "America/New_York",
  "maxConcurrent": 1
}
\`\`\`

When setting up scheduled jobs:
- Read \`~/.maximus/agents/\` first to know which agents are available and what they can do
- Write the job to \`~/.maximus/jobs.json\` (create the file if it doesn't exist — it's a JSON array)
- The scheduler picks up changes on reload. Use the API (\`POST /api/jobs\`) or write the file directly.
- For agent swarms (e.g. a CEO agent that delegates to specialists), schedule the top-level orchestrator — it will delegate to its sub-agents automatically
- Use \`POST /api/jobs/:id/run\` to trigger a job immediately for testing before relying on the cron schedule

## Agent Memory

Agents can have persistent memory that accumulates over sessions. The memory system tracks episodes (structured session summaries), knowledge (entity-relationship graph), and metrics (performance over time).

### Key concepts
- **Episodes**: Structured records of agent sessions with lessons learned, strategies, and failure patterns
- **Knowledge Graph**: Entities and relationships stored as temporal triples with scope hierarchy (agent -> team -> global)
- **Briefings**: Auto-generated context injected into agent prompts before sessions
- **Deep Sleep**: Scheduled consolidation job that processes traces, extracts knowledge, generates briefings, and promotes high-value facts

### Memory CLI commands
- \`maximus memory status\` -- show entity/triple counts, episode counts, last consolidation
- \`maximus memory inspect <agent>\` -- show agent's episodes, briefing, and knowledge
- \`maximus memory promote <sourceId> <predicate> <targetId>\` -- manually promote a fact to a higher scope

### Enabling memory for an agent
Add a \`memory:\` block to the agent's frontmatter:
\`\`\`yaml
memory:
  episodic: true
  maxEpisodes: 50
  briefingEnabled: true
  learningRate: moderate
\`\`\`

### Dashboard
The dashboard has two memory views:
- **Knowledge** (sidebar) -- force-directed graph of entities and relationships, filterable by scope
- **Memory** (sidebar) -- per-agent view showing episodes, metrics charts, and active briefing`;

export function getOrchestratorPrompt(name: string): string {
	return PROMPT_TEMPLATE.replaceAll("{{name}}", name);
}

export function getOrchestratorDefinition(name: string): string {
	const prompt = getOrchestratorPrompt(name);
	return `---
name: ${name}
description: Orchestrates tasks and manages the agent team
model: sonnet
maxTurns: 50
---

${prompt}
`;
}

export const DOCS_AGENTS = `# Creating Agents

Agents are defined as Markdown files with YAML frontmatter in ~/.maximus/agents/.

## Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Unique agent identifier (lowercase, hyphens ok) |
| description | string | No | What this agent does |
| model | sonnet/opus/haiku | No | Claude model to use (default: sonnet) |
| maxTurns | number | No | Max conversation turns (default: 50) |
| skills | string[] | No | List of skill names this agent can use |
| reportsTo | string | No | Name of parent agent for delegation hierarchy |

## Example

\`\`\`markdown
---
name: researcher
description: Researches topics and gathers information
model: sonnet
maxTurns: 30
skills:
  - web-search
reportsTo: maximus
---

You are a research specialist. When given a research task:
1. Break the topic into specific questions
2. Use your web-search skill to find information
3. Synthesize findings into a clear summary
4. Flag any conflicting information
\`\`\`

## Hierarchy

- Agents with \`reportsTo\` are workers under a parent agent
- The orchestrator is the top-level agent with no reportsTo
- Parent agents can delegate tasks to their direct reports
- Workers report results back to their parent

## Tips

- Keep system prompts focused — one clear role per agent
- Use skills to give agents access to external APIs
- Start simple, add complexity as needed
`;

export const DOCS_SKILLS = `# Creating Skills

Skills are YAML files in ~/.maximus/skills/ that give agents access to external APIs and services.

## Structure

\`\`\`yaml
name: skill-name
description: What this skill provides
version: "1.0"

credentials:
  - name: api_key_name
    description: What this credential is used for

tools:
  - name: tool_name
    description: What this tool does
    parameters:
      param_name:
        type: string
        description: "Parameter description"
      optional_param:
        type: number
        description: "Optional parameter"
        required: false
    credentials:
      - ref: api_key_name
        inject_as: API_KEY
    action:
      type: http
      method: GET
      url: "https://api.example.com/search?q={{param_name}}&key={{API_KEY}}"

instructions: |
  Usage guidelines for agents using this skill.
\`\`\`

## Key Concepts

- **Credentials**: Secrets stored in the vault, never exposed to agents. Referenced by name, resolved at execution time.
- **Tools**: Actions agents can perform. Each tool has parameters, optional credential refs, and an HTTP action.
- **inject_as**: Maps a vault credential to a template variable in the URL/body/headers.
- **Parameters**: Typed inputs the agent provides when calling the tool.

## Steps to Create a Skill

1. Determine what API or service is needed
2. Design the tool parameters
3. Identify required credentials
4. Write the YAML file to ~/.maximus/skills/{skill-name}.yaml
5. Remind the user to set credentials: /vault set <credential-name>
6. Add the skill name to the agent's skills list
`;

export const DOCS_VAULT = `# Vault

The vault stores encrypted credentials that agents need for their skills/tools.

## Usage

- Set a credential: \`/vault set <name>\` in the REPL or \`maximus vault set <name>\`
- List credentials: \`/vault list\`
- Delete a credential: \`/vault delete <name>\`

## How It Works

- Agents never see credential values — the system resolves them when executing tool actions
- Credentials are referenced by name in skill definitions
- The vault is encrypted with AES-256-GCM using the vault key
- The vault key is set during \`/init\` and stored in ~/.maximus/.env

## Example Flow

1. Create a skill that needs an API key (credential ref: \`github_token\`)
2. User runs \`/vault set github_token\` and pastes their token
3. When an agent uses the skill's tool, the system injects the token into the HTTP request
4. The agent only sees the API response, never the token
`;
