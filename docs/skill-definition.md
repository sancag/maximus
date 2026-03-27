# Skill Definition Format

## Overview

Skills are YAML files that define a set of tools an agent can use. Each skill bundles related tools, their parameter schemas, credential requirements, and usage instructions. Skills are the bridge between what an agent wants to do (create an issue, send an email) and how it gets done (HTTP calls with authentication).

## Schema

Top-level fields for a skill definition file:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Unique identifier (lowercase letters, numbers, hyphens) |
| description | string | Yes | What this skill provides |
| version | string | No | Skill version (default `"1.0"`) |
| credentials | array | No | Credentials this skill needs from the vault (name + description) |
| tools | array | Yes | Tool definitions (at least one required) |
| instructions | string | No | Usage guidance appended to agent prompt context |

## Tool Definition

Each entry in the `tools` array defines a single tool:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Tool name (lowercase, underscores allowed, e.g. `github_create_issue`) |
| description | string | Yes | What this tool does (shown to the agent) |
| parameters | object | Yes | Parameter definitions (see below) |
| credentials | array | No | Credential references for this specific tool |
| action | object | No | HTTP action definition |
| output | object | No | Output filtering configuration |

## Parameters

Each parameter is defined as a key-value pair under `parameters`:

```yaml
parameters:
  repo:
    type: string
    description: "Repository in owner/name format"
  count:
    type: number
    description: "Number of items to return"
    required: false
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| type | `"string"` \| `"number"` \| `"boolean"` | Yes | - | Parameter type |
| description | string | Yes | - | Description shown to the agent |
| required | boolean | No | `true` | Whether the parameter must be provided |

## Credential References

The `credentials` field on a tool maps vault credential names to injection variables. Credentials are resolved at tool execution time from the encrypted vault and are never visible to agents.

```yaml
credentials:
  - ref: github_token
    inject_as: GITHUB_TOKEN
```

| Field | Type | Description |
|-------|------|-------------|
| ref | string | Name of the credential in the vault |
| inject_as | string | Template variable name used in action templates |

The `ref` must match a credential stored in the vault via `CredentialVault.set()`. The `inject_as` value becomes available as a `{{VARIABLE}}` in action templates.

## Action

The `action` field defines an HTTP request to execute when the tool is called:

```yaml
action:
  type: http
  method: POST
  url: "https://api.github.com/repos/{{repo}}/issues"
  headers:
    Authorization: "Bearer {{GITHUB_TOKEN}}"
    Content-Type: application/json
  body:
    title: "{{title}}"
    body: "{{body}}"
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| type | `"http"` | Yes | Action type (currently only HTTP supported) |
| method | `GET` \| `POST` \| `PUT` \| `PATCH` \| `DELETE` | Yes | HTTP method |
| url | string | Yes | URL template (supports `{{variable}}` substitution) |
| headers | object | No | Request headers (supports `{{variable}}` substitution) |
| body | object | No | Request body (supports `{{variable}}` substitution) |

Template variables use `{{variable}}` syntax. Variables come from two sources:
- **Parameters:** Values provided by the agent (e.g., `{{repo}}`, `{{title}}`)
- **Credentials:** Values injected from the vault (e.g., `{{GITHUB_TOKEN}}`)

## Output Filtering

The `output` field controls what data is returned to the agent:

```yaml
output:
  include:
    - number
    - html_url
    - state
```

`output.include` is an allowlist of response fields returned to the agent. Unlisted fields are stripped from the response. This prevents agents from seeing unnecessary data (internal IDs, metadata, etc.) and keeps context windows focused.

## Example

```yaml
name: github-operations
description: Create and manage GitHub issues, PRs, and repositories
version: "1.0"

credentials:
  - name: github_token
    description: GitHub Personal Access Token with repo scope

tools:
  - name: github_create_issue
    description: Create an issue on a GitHub repository
    parameters:
      repo:
        type: string
        description: "Repository in owner/name format"
      title:
        type: string
        description: "Issue title"
      body:
        type: string
        description: "Issue body"
    credentials:
      - ref: github_token
        inject_as: GITHUB_TOKEN
    action:
      type: http
      method: POST
      url: "https://api.github.com/repos/{{repo}}/issues"
      headers:
        Authorization: "Bearer {{GITHUB_TOKEN}}"
        Content-Type: application/json
      body:
        title: "{{title}}"
        body: "{{body}}"
    output:
      include:
        - number
        - html_url
        - state

instructions: |
  When working with GitHub:
  - Always check if an issue already exists before creating a new one
  - Use descriptive titles that summarize the problem
  - Include relevant context in the issue body
```

## File Location

Skill definition files go in the `skills/` directory at the repository root, with a `.yaml` or `.yml` extension. All YAML files in this directory are loaded at engine startup.

```
skills/
  github-operations.yaml
  slack-notifications.yaml
  jira-management.yaml
```

## Design Philosophy

YAML defines **WHAT** (tool shapes, credential refs), never **HOW** (no conditionals, loops, or variables beyond templates). The skill format is deliberately declarative:

- Tool parameters describe the interface
- Actions describe the HTTP call template
- Credentials describe what secrets are needed

For complex logic (retry strategies, conditional workflows, data transformation), write a TypeScript tool handler instead. The YAML format is for straightforward API integrations.
