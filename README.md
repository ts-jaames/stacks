# Stacks

> Evidence lineage and governance for agent-generated work

Stacks is a platform where humans review, trace, and govern what AI agents produce. Agents handle the heavy lifting — ingesting evidence, synthesizing patterns, generating artifacts — while Stacks provides the interface to inspect lineage, judge quality, and decide what becomes canonical.

**Stacks is not where work gets done. It's where work gets understood and trusted.**

## How It Works

```
Agents produce  →  Stacks organizes  →  Humans govern
```

Every piece of content has **lineage** — a traceable chain from raw evidence through synthesis to final artifact. When an agent generates a roadmap, you can trace it back through the syntheses it drew from, down to the original interviews, documents, and decisions that informed it.

## Core Concepts

### Fieldbooks

Long-lived, forkable lineage graphs that preserve how decisions, assumptions, artifacts, and outcomes relate over time. A fieldbook is the evidence record for how understanding evolved.

### The Spine

A three-column layout for tracing agent output back to its origins:

- **Sources** — Raw inputs: interviews, transcripts, documents, meeting notes, external links
- **Syntheses** — Patterns and insights derived from sources
- **Artifacts** — Deliverables: architecture docs, roadmaps, backlogs, cost models, decision records

Read left to right to see how evidence becomes a deliverable. Read right to left to audit why an artifact says what it says.

### Governance

The trust boundary between agent and human:

- Agents create freely, but everything starts as `draft` or `proposed` — never `canonical`
- Agent edits create new versions; they never overwrite human-approved content
- Recalibrations are proposals with rationale, not silent rewrites
- Every agent action emits a **movement event** — a permanent audit record

### Reverberation (Propagation)

When upstream evidence changes, downstream content reacts automatically:

1. **Content-aware diffing** — The system computes a real diff of what changed in the source, extracts text from TipTap JSON, and propagates a meaningful before/after to every affected synthesis and artifact
2. **Confidence degradation** — Each affected item's confidence score drops by 15% (floor 20), and any human override is cleared, signaling that the evidence base has shifted
3. **Visual feedback** — Affected items show a recalibration animation, followed by a banner with the specific change and an Accept/Ignore choice
4. **AI suggestions** — When Portkey is configured, AI generates context-aware suggestions for how downstream content should be updated; without Portkey, a structured local fallback references the specific source change

Nothing auto-updates. Humans always decide whether to accept, modify, or ignore proposed changes.

### Confidence Scores

Every synthesis and artifact carries a confidence score (0–100%) that reflects how trustworthy the content is relative to its evidence:

- **AI-generated** — Initial scores are set when content is created
- **Human-overridable** — Practitioners can override the AI score at any time via an inline editor
- **Living signal** — Scores degrade automatically when upstream sources change, and human overrides are cleared until the practitioner re-evaluates
- **Visual indicators** — Semantic color coding (green/gray/amber) in both the editor and sidebar list items

### Semantic Layer

Every node carries structured metadata: **status** (`draft` → `canonical`), **visibility** (`internal` → `client_facing`), **tags**, **owner**, and **type** — all constrained by a central catalog.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js 18+

### Install

```bash
cd fieldbook
bun install
```

### Environment

Create `fieldbook/.env.local`:

```env
PORTKEY_API_KEY=your-portkey-api-key
PORTKEY_VIRTUAL_KEY=your-virtual-key-slug

NEXTAUTH_SECRET=your-secret
NEXTAUTH_URL=http://localhost:3000
```

### Run

```bash
cd fieldbook
bun dev
```

Open [http://localhost:3000](http://localhost:3000)

## API

REST API at `/api/v2/` with standard envelope responses (`{ ok, data, meta }`).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v2/fieldbooks` | GET | List all fieldbooks |
| `/api/v2/fieldbooks/:id` | GET | Single fieldbook with node summaries |
| `/api/v2/fieldbooks/:id/nodes` | GET | All nodes (flat list) |
| `/api/v2/fieldbooks/:id/nodes/:nodeId` | GET | Single node with content |
| `/api/v2/fieldbooks/:id/lineage` | GET | Full graph (nodes + edges) |
| `/api/v2/fieldbooks/:id/lineage/:nodeId` | GET | Node subgraph (`?depth=1\|full`) |
| `/api/v2/fieldbooks/:id/movements` | GET | Audit trail (`?type=&limit=&since=`) |
| `/api/v2/catalog` | GET | Allowed enum values |
| `/api/v2/search` | GET | Full-text search with filters |
| `/api/v2/fieldbooks/:id/nodes` | POST | Create a source |
| `/api/v2/fieldbooks/:id/nodes/:nodeId/versions` | POST | Create a new version |
| `/api/v2/fieldbooks/:id/nodes/:nodeId/propose-recalibration` | POST | Propose recalibration |
| `/api/v2/fieldbooks/:id/compile` | POST | Compile node into agent/human output |

All write endpoints accept an `X-Actor` header (`user:<id>` or `agent:<id>:<name>`) for governance.

## MCP Server

The MCP server is how AI agents interact with Stacks — reading evidence, creating content, compiling context, and proposing changes, all under the same governance model.

### Run

```bash
cd fieldbook
bun run mcp/server.ts
```

### Connect (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "stacks": {
      "command": "bun",
      "args": ["run", "/path/to/fieldbook/mcp/server.ts"]
    }
  }
}
```

### Tools

| Tool | Description |
|------|-------------|
| `search_stacks` | Full-text search with status/visibility/tag filters |
| `list_nodes` | List all nodes with semantic metadata |
| `get_lineage` | Upstream/downstream graph for a node |
| `get_context` | Compile a context bundle (JSON, markdown, lineage) |
| `create_source` | Add a new source (governed) |
| `propose_edit` | Create a new version (never overwrites canonical) |
| `propose_recalibration` | Propose recalibration with rationale |

## Project Structure

```
fieldbook/
├── app/
│   ├── api/
│   │   ├── ai/                 # AI generation endpoints
│   │   ├── db/                 # Database CRUD
│   │   ├── v1/                 # Phase 0 graph API
│   │   └── v2/                 # Governed API (current)
│   ├── components/
│   │   ├── editor/             # TipTap document editor
│   │   └── spine/              # Spine layout
│   ├── hooks/                  # React hooks
│   └── lib/
│       ├── api/                # Response envelope + actor parsing
│       ├── compile/            # Compile engine
│       ├── db/                 # JSON database layer
│       ├── lineage/            # Graph walker
│       ├── governance.ts       # Actor-based mutation guard
│       └── reverberation.ts    # Propagation engine (diffing, confidence degradation)
├── config/
│   └── catalog.json            # Semantic enum definitions
├── mcp/
│   ├── server.ts               # MCP server entry point
│   ├── resources/              # Browsable MCP resources
│   └── tools/                  # MCP tool implementations
├── data/
│   └── data.json               # Local JSON database
└── docs/                       # Architecture plans
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| UI | React 19, Tailwind CSS 4 |
| Editor | TipTap / ProseMirror |
| Auth | NextAuth v5 |
| AI | OpenAI via Portkey gateway |
| Agent protocol | MCP (`@modelcontextprotocol/sdk`) |
| Validation | Zod 4 |
| Persistence | JSON (PostgreSQL via Prisma planned) |

## AI Capabilities

| Capability | Description |
|-----------|-------------|
| Generate | Creates synthesis/artifact content with type-specific prompts |
| Streaming synthesis | Real-time markdown generation |
| Overlap detection | Checks new sources against existing syntheses |
| Source ranking | Scores sources by relevance to a task |
| Condense | Shortens content while preserving key points |
| Suggest adjustment | Proposes context-aware changes when upstream evidence shifts |
| Confidence scoring | AI-generated confidence with human override support |
| Content-aware propagation | Computes real source-level diffs for downstream flagging |

## License

Proprietary — Sparq.
