# Agent Definition Format

## Overview

Agents are defined as Markdown files with YAML frontmatter. The frontmatter contains metadata (name, description, model, skills). The Markdown body becomes the agent's system prompt, sent to Claude at the start of every session.

This format was chosen because Markdown is natural for writing prompts, and YAML frontmatter provides structured metadata without introducing a separate config file.

## Schema

All frontmatter fields for an agent definition file:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | - | Unique identifier for this agent (1-100 characters) |
| description | string | Yes | - | Brief description of the agent's role (1-500 characters) |
| model | `"sonnet"` \| `"opus"` \| `"haiku"` | No | `"sonnet"` | Claude model to use for this agent |
| maxTurns | number | No | `25` | Maximum tool-use turns per session (1-500) |
| maxDurationSeconds | number | No | - | Maximum wall-clock time in seconds before the session is aborted (10-3600) |
| skills | string[] | No | `[]` | Skill names to attach (must match skill YAML filenames) |
| reportsTo | string | No | - | Name of parent agent (for Phase 2 hierarchy) |

## System Prompt

The Markdown body (everything after the closing `---` frontmatter delimiter) becomes the agent's system prompt. This is sent to Claude as the `systemPrompt` option in every SDK query session.

Write clear personality, role definition, and behavioral instructions here. The prompt should tell the agent:

- What role it plays
- How it should approach tasks
- What constraints or guidelines to follow
- How to use its available tools

## Example

```markdown
---
name: engineering-lead
description: Engineering team manager who breaks down complex tasks
model: sonnet
maxTurns: 30
skills:
  - github-operations
---

You are a pragmatic engineering manager who breaks down complex tasks
into well-scoped work items. You prefer working solutions over
perfect architectures.

When given a task:
1. Analyze the requirements
2. Break into sub-tasks if complex
3. Execute or delegate each sub-task
4. Verify results before reporting back

Always explain your reasoning and trade-offs.
```

## File Location

Agent definition files go in the `agents/` directory at the repository root, with a `.md` extension. All `.md` files in this directory are automatically loaded when the engine starts via `AgentEngine.initialize()`.

```
agents/
  engineering-lead.md
  code-reviewer.md
  qa-analyst.md
```

## Validation

Agent files are validated against the Zod schema at load time. The `loadAgentDefinition()` function parses the YAML frontmatter and validates it against `agentFrontmatterSchema`. Invalid files produce descriptive error messages with the field name and expected type.

Common validation errors:

- Missing `name` or `description` (required fields)
- `name` exceeding 100 characters
- `model` not one of `"sonnet"`, `"opus"`, `"haiku"`
- `maxTurns` outside the 1-200 range
- `skills` containing non-string values
