/**
 * Realistic multi-cycle trading swarm simulation.
 *
 * Models the actual hl-* agent team from ~/.maximus/agents/:
 *   hl-ceo (leadership), hl-market-analyst + hl-strategist (research),
 *   hl-risk-manager + hl-order-executor (execution), hl-portfolio-tracker (ops)
 *
 * Runs 3 pipeline cycles (simulating consecutive trading days) so knowledge
 * accumulates across runs and scope promotion can fire naturally.
 *
 * What to look for:
 *   - Do domain concepts (funding rates, stop-loss, fee structure) get extracted?
 *   - Do agents in the same team extract overlapping triples → promotion fires?
 *   - Do briefings contain actionable knowledge before session N+1?
 *   - What gaps does GapAnalyzer surface?
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MemoryEngine } from "../engine.js";
import { DeepSleepPipeline } from "../pipeline/deep-sleep-pipeline.js";
import { EpisodeStore } from "../sqlite/episodes.js";
import { KnowledgeStore } from "../kuzu/knowledge-store.js";
import { BriefingGenerator } from "../briefing/briefing-generator.js";
import { BriefingStore } from "../sqlite/briefing-store.js";
import { GapAnalyzer } from "../test-engine/validators/gap-analyzer.js";
import { deepSleepConfigSchema } from "@maximus/shared";
import type { PipelineResult, AgentEvent } from "@maximus/shared";

// ---------------------------------------------------------------------------
// Agent team — mirrors ~/.maximus/agents/
// ---------------------------------------------------------------------------

const AGENTS = [
  { name: "hl-ceo",              team: "leadership", model: "opus",   tools: ["mcp____delegation__delegate", "mcp____delegation__wait_for_tasks"] },
  { name: "hl-market-analyst",   team: "research",   model: "sonnet", tools: ["get_all_mids", "get_funding_and_meta", "get_order_book", "get_candles"] },
  { name: "hl-strategist",       team: "research",   model: "opus",   tools: ["get_funding_and_meta", "get_order_book"] },
  { name: "hl-risk-manager",     team: "execution",  model: "sonnet", tools: ["get_account_state", "get_positions"] },
  { name: "hl-order-executor",   team: "execution",  model: "sonnet", tools: ["set_leverage", "place_bracket_order", "modify_order", "market_close"] },
  { name: "hl-portfolio-tracker",team: "ops",        model: "sonnet", tools: ["get_account_state", "get_positions", "get_fills"] },
];

// ---------------------------------------------------------------------------
// Realistic task corpus per agent (based on real prompts and memory notes)
// Each entry: [taskDescription, outcome, lessonsLearned, effectiveStrategies, failurePatterns, tools]
// ---------------------------------------------------------------------------

type EpisodeSpec = {
  task: string;
  outcome: "success" | "failure" | "partial";
  lessons: string[];
  strategies: string[];
  failures: string[];
  tools: string[];
};

const EPISODE_CORPUS: Record<string, EpisodeSpec[]> = {
  "hl-ceo": [
    {
      task: "Run full trading cycle: market research, risk assessment, and execute if conditions are right",
      outcome: "success",
      lessons: ["Parallel delegation to market-analyst and portfolio-tracker cuts cycle time by 60%"],
      strategies: ["Fan out reconnaissance agents first, synthesize before delegating to strategist"],
      failures: [],
      tools: ["mcp____delegation__delegate", "mcp____delegation__wait_for_tasks"],
    },
    {
      task: "Coordinate trading cycle after BTC made 3% move in 1 hour",
      outcome: "success",
      lessons: ["Fast moves without volume often reverse — mean reversion outperformed momentum in this case"],
      strategies: ["Request order book depth from analyst before approving breakout signals"],
      failures: [],
      tools: ["mcp____delegation__delegate", "mcp____delegation__wait_for_tasks"],
    },
    {
      task: "Emergency portfolio review after SOL position hit stop-loss",
      outcome: "success",
      lessons: ["Stop-loss orders require place_trigger_order, not place_order with reduce_only — critical distinction"],
      strategies: ["Always confirm stop fills via portfolio-tracker after execution before reporting to user"],
      failures: [],
      tools: ["mcp____delegation__delegate", "mcp____delegation__wait_for_tasks"],
    },
    {
      task: "Run trading cycle — high funding rate environment across BTC, ETH, SOL",
      outcome: "success",
      lessons: ["Funding above 0.01%/8h on 3+ coins simultaneously signals market top — reduce long exposure"],
      strategies: ["Bias toward funding rate arb shorts when multiple coins show elevated positive funding"],
      failures: [],
      tools: ["mcp____delegation__delegate", "mcp____delegation__wait_for_tasks"],
    },
    {
      task: "Cycle aborted: risk manager vetoed trade due to daily drawdown threshold hit",
      outcome: "failure",
      lessons: ["5% daily drawdown limit is absolute — all new positions halted regardless of signal quality"],
      strategies: [],
      failures: ["Trade rejected by risk manager: daily drawdown at 5.1%, halt rule triggered"],
      tools: ["mcp____delegation__delegate"],
    },
    {
      task: "Run trading cycle — assess whether to add to winning ETH long",
      outcome: "success",
      lessons: ["Position pyramiding requires risk manager approval each time — treat as a new trade"],
      strategies: ["Scale in with reduced size (half of original) when adding to winner"],
      failures: [],
      tools: ["mcp____delegation__delegate", "mcp____delegation__wait_for_tasks"],
    },
  ],

  "hl-market-analyst": [
    {
      task: "Provide comprehensive market overview — prices, funding, order books for top perpetuals",
      outcome: "success",
      lessons: ["BTC and ETH funding rates are highly correlated — rarely diverge by more than 0.003%/8h"],
      strategies: ["Fan out all API calls in parallel in turn 1: get_all_mids, get_funding_and_meta, get_order_books simultaneously"],
      failures: [],
      tools: ["get_all_mids", "get_funding_and_meta", "get_order_book"],
    },
    {
      task: "Scan market for funding rate arbitrage opportunities — identify coins with extreme funding",
      outcome: "success",
      lessons: ["Coins with funding above 0.015%/8h tend to revert within 24h — strong fade signal"],
      strategies: ["Sort coins by absolute funding rate, focus analysis on top 5 outliers"],
      failures: [],
      tools: ["get_funding_and_meta", "get_all_mids"],
    },
    {
      task: "Fetch candle data for SOL-PERP breakout analysis — 15min and 1h timeframes",
      outcome: "success",
      lessons: ["Breakout confirmation requires volume spike of at least 150% of 20-period average"],
      strategies: ["Compare 15min candle volume to baseline before flagging breakout to strategist"],
      failures: [],
      tools: ["get_candles", "get_order_book"],
    },
    {
      task: "Market snapshot — assess conditions after overnight session, BTC down 4%",
      outcome: "success",
      lessons: ["Thin order books during low-liquidity hours amplify price moves — data from off-hours is less reliable"],
      strategies: ["Flag spread widening (>0.05%) as a liquidity warning in the report"],
      failures: [],
      tools: ["get_all_mids", "get_order_book", "get_funding_and_meta"],
    },
    {
      task: "Fetch market data — API returned stale funding rates (15 min old)",
      outcome: "partial",
      lessons: ["Funding rate data can be stale — always check timestamp field in API response"],
      strategies: ["Request data twice if timestamp age exceeds 5 minutes"],
      failures: ["Stale funding data delivered to strategist — rates were 15min old, signal quality degraded"],
      tools: ["get_funding_and_meta"],
    },
    {
      task: "Monitor watchlist coins: ARB, SUI flagged for elevated funding",
      outcome: "success",
      lessons: ["Watchlist maintenance improves signal quality — coins monitored over 3+ days have better pattern recognition"],
      strategies: ["Update watchlist after every cycle: add new outliers, remove coins that normalized"],
      failures: [],
      tools: ["get_all_mids", "get_funding_and_meta", "get_order_book"],
    },
    {
      task: "Confirm funding rate arb entry threshold with strategist — BTC at 0.011%/8h for 4 periods",
      outcome: "success",
      lessons: [
        "funding_rate_threshold: funding above 0.01%/8h sustained for 3+ consecutive 8h periods is the team entry threshold for arb",
        "place_trigger_order with reduce_only=true is required for all stop-losses — place_order must never be used for stops",
      ],
      strategies: ["Report consecutive elevated periods explicitly — strategist needs the streak count, not just current rate"],
      failures: [],
      tools: ["get_funding_and_meta"],
    },
  ],

  "hl-strategist": [
    {
      task: "Analyze market data and generate trade signal — BTC funding at +0.012%/8h",
      outcome: "success",
      lessons: ["Funding rate arb is most reliable when funding has been elevated for 3+ consecutive 8h periods"],
      strategies: ["Calculate net R:R after fees explicitly — 0.09% round-trip taker cost must be factored in"],
      failures: [],
      tools: ["get_funding_and_meta", "get_order_book"],
    },
    {
      task: "Generate signal for SOL — momentum breakout above key resistance on volume",
      outcome: "success",
      lessons: ["Minimum 1.5:1 R:R after fees is non-negotiable — rejected two signals that failed this threshold"],
      strategies: ["Use limit entry orders to get maker rate (0.06% round-trip vs 0.09% taker-taker)"],
      failures: [],
      tools: ["get_order_book"],
    },
    {
      task: "Analyze ETH for mean reversion — moved 3.2% in 45 minutes without catalyst",
      outcome: "success",
      lessons: ["Mean reversion entries at 1.5-2x ATR extension have better fill rates with limit orders"],
      strategies: ["Set limit order at 62% fibonacci retracement of the extended move for optimal entry"],
      failures: [],
      tools: ["get_candles", "get_order_book"],
    },
    {
      task: "Generate signal — ARB showing negative funding -0.018%/8h for 24 hours",
      outcome: "success",
      lessons: ["Negative funding arb longs are lower risk than positive funding shorts — liquidation risk profile differs"],
      strategies: ["Size negative funding longs at 8% of account — slightly larger than short arb due to lower squeeze risk"],
      failures: [],
      tools: ["get_funding_and_meta"],
    },
    {
      task: "Signal generation failed — market conditions unclear, multiple conflicting indicators",
      outcome: "failure",
      lessons: ["No signal is a valid output — never force a trade when indicators conflict"],
      strategies: [],
      failures: ["Attempted to generate signal despite conflicting funding and momentum indicators — output was low confidence"],
      tools: ["get_funding_and_meta", "get_order_book"],
    },
    {
      task: "Batch analysis: scan 20 coins for funding rate opportunities",
      outcome: "success",
      lessons: ["BTC and ETH rarely offer arb simultaneously — they tend to normalize together"],
      strategies: ["Focus funding arb scanning on mid-cap perps (SOL, ARB, SUI, AVAX) where funding is more volatile"],
      failures: [],
      tools: ["get_funding_and_meta", "get_all_mids"],
    },
    {
      task: "Validate entry criteria — analyst confirms BTC funding elevated 4 consecutive 8h periods",
      outcome: "success",
      lessons: [
        "funding_rate_threshold: funding above 0.01%/8h sustained for 3+ consecutive 8h periods is the team entry threshold for arb",
        "place_trigger_order with reduce_only=true is required for all stop-losses — place_order must never be used for stops",
      ],
      strategies: ["Always request streak count from analyst, not just current funding level — duration validates signal quality"],
      failures: [],
      tools: ["get_funding_and_meta", "get_order_book"],
    },
  ],

  "hl-risk-manager": [
    {
      task: "Evaluate BTC short signal — 8% position size, stop at +1.2%",
      outcome: "success",
      lessons: ["Total exposure check must include both unrealized P&L and notional of all positions"],
      strategies: ["Approve with reduced size when signal quality is high but exposure limit is near"],
      failures: [],
      tools: ["get_account_state", "get_positions"],
    },
    {
      task: "Risk assessment for SOL long — account at 30% exposure already",
      outcome: "success",
      lessons: ["Correlation check is critical — BTC and ETH longs simultaneously violate correlation rule"],
      strategies: ["Use systematic checklist: position size, total exposure, drawdown, stop loss, R:R, correlation"],
      failures: [],
      tools: ["get_account_state", "get_positions"],
    },
    {
      task: "Emergency risk review — daily drawdown reached 3% threshold",
      outcome: "success",
      lessons: ["At 3% drawdown, halve all position sizes — do not wait for next cycle to apply the rule"],
      strategies: ["Proactively reduce existing positions when drawdown threshold is approaching"],
      failures: [],
      tools: ["get_account_state", "get_positions"],
    },
    {
      task: "Rejected trade signal — stop loss not defined by strategist",
      outcome: "failure",
      lessons: ["Stop loss is mandatory — no exceptions even for high-conviction signals"],
      strategies: [],
      failures: ["Trade approved without stop loss — position opened, price moved against us, manual close required"],
      tools: ["get_account_state"],
    },
    {
      task: "Evaluate funding arb trade — fee structure analysis for small account",
      outcome: "success",
      lessons: ["For accounts under $500, fee cost on 8% position can exceed 10% of expected reward — always calculate explicitly"],
      strategies: ["Flag fee-to-reward ratio above 10% as a warning — consider reducing size or skipping trade"],
      failures: [],
      tools: ["get_account_state", "get_positions"],
    },
    {
      task: "Approved modified ETH long — reduced size to 6% from proposed 10% due to correlation",
      outcome: "success",
      lessons: ["Modified approvals are preferable to rejections — preserve team velocity while managing risk"],
      strategies: ["When modifying size, explain the math explicitly so strategist can recalculate R:R"],
      failures: [],
      tools: ["get_account_state", "get_positions"],
    },
    {
      task: "Pre-trade checklist review — confirmed executor is using correct stop-loss API",
      outcome: "success",
      lessons: [
        "place_trigger_order with reduce_only=true is required for all stop-losses — place_order must never be used for stops",
        "set_leverage must be called before place_bracket_order — skipping it causes silent order failure",
      ],
      strategies: ["Require executor to confirm stop placement method before approving any trade"],
      failures: [],
      tools: ["get_account_state"],
    },
  ],

  "hl-order-executor": [
    {
      task: "Execute approved BTC short — entry limit $67,400, SL $68,100, TP $66,200",
      outcome: "success",
      lessons: ["set_leverage must be called before place_bracket_order — order fails silently if skipped"],
      strategies: ["Always use place_bracket_order for new positions — atomic entry + SL + TP prevents orphaned stops"],
      failures: [],
      tools: ["set_leverage", "place_bracket_order"],
    },
    {
      task: "Execute SOL long — stop-loss placement using place_trigger_order",
      outcome: "success",
      lessons: ["place_trigger_order is required for stop-losses, not place_order — reduce_only must be true on SL"],
      strategies: ["For bracket orders: entry GTC limit, SL trigger isMarket=true, TP trigger isMarket=false"],
      failures: [],
      tools: ["set_leverage", "place_bracket_order"],
    },
    {
      task: "Emergency close ETH position — manual stop triggered at loss",
      outcome: "success",
      lessons: ["market_close flattens immediately regardless of existing orders — safest emergency exit"],
      strategies: ["After market_close, verify via get_positions that size is 0 before reporting success"],
      failures: [],
      tools: ["market_close", "get_positions"],
    },
    {
      task: "Stop-loss order placed incorrectly — reduce_only was false, opened reverse position",
      outcome: "failure",
      lessons: ["reduce_only: false on a stop-loss opens a new position instead of closing — catastrophic error"],
      strategies: [],
      failures: ["Stop-loss used place_order instead of place_trigger_order — reduce_only was hardcoded false in body, opened opposing position"],
      tools: ["place_bracket_order"],
    },
    {
      task: "Modify stop-loss — trail to breakeven after position moved 1.5R in profit",
      outcome: "success",
      lessons: ["modify_order can move SL to breakeven — always trail to cost basis when position reaches 1R profit"],
      strategies: ["Trail SL in two steps: first to breakeven at 1R, then to +0.5R at 2R, never let a winner become a loser"],
      failures: [],
      tools: ["modify_order"],
    },
    {
      task: "Execute ARB funding arb long — set 5x leverage, limit entry near mid",
      outcome: "success",
      lessons: ["Hyperliquid unified wallet means spot USDC is immediately available as perp margin — no transfer needed"],
      strategies: ["Use limit orders at mid price for maker fee rate — saves 0.03% per side vs taker"],
      failures: [],
      tools: ["set_leverage", "place_bracket_order"],
    },
    {
      task: "Post-incident review — stop-loss caused reverse position due to wrong API call",
      outcome: "failure",
      lessons: [
        "place_trigger_order with reduce_only=true is required for all stop-losses — place_order must never be used for stops",
        "set_leverage must be called before place_bracket_order — skipping it causes silent order failure",
      ],
      strategies: [],
      failures: ["Used place_order for stop-loss instead of place_trigger_order — opened reverse position instead of closing"],
      tools: ["place_bracket_order"],
    },
  ],

  "hl-portfolio-tracker": [
    {
      task: "Generate portfolio report — account state, open positions, today's P&L",
      outcome: "success",
      lessons: ["Unrealized P&L on open positions must be included in total equity calculation"],
      strategies: ["Always report available margin separately from total equity — they diverge when positions are open"],
      failures: [],
      tools: ["get_account_state", "get_positions", "get_fills"],
    },
    {
      task: "Confirm BTC short order filled and SL/TP active",
      outcome: "success",
      lessons: ["After bracket order, verify all 3 orders appear in open orders — entry fill + SL active + TP active"],
      strategies: ["Check get_positions for entry fill, get_open_orders for SL and TP confirmation"],
      failures: [],
      tools: ["get_positions", "get_account_state"],
    },
    {
      task: "Weekly performance summary — win rate, avg R:R, total return",
      outcome: "success",
      lessons: ["Win rate alone is misleading — a 40% win rate with 3:1 R:R outperforms 70% win rate with 0.8:1"],
      strategies: ["Track expected value per trade: (win% × avg_winner) - (loss% × avg_loser) as primary metric"],
      failures: [],
      tools: ["get_fills", "get_account_state"],
    },
    {
      task: "Emergency report — position stuck open after stop-loss fired incorrectly",
      outcome: "failure",
      lessons: ["Incorrect stop-loss (reduce_only=false) opens reverse position — requires immediate market_close plus cancel all"],
      strategies: [],
      failures: ["Reported double position after stop-loss bug — market_close on original + new opposing position required"],
      tools: ["get_positions", "get_account_state"],
    },
    {
      task: "Track funding payments received — long SOL held overnight, collected negative funding",
      outcome: "success",
      lessons: ["Funding payments accumulate per 8h period — holding a funding arb position overnight collects 3 payments"],
      strategies: ["Report funding income separately in P&L breakdown — it is core to arb strategy profitability assessment"],
      failures: [],
      tools: ["get_fills", "get_account_state"],
    },
    {
      task: "Position monitoring — check if BTC position approaching liquidation price",
      outcome: "success",
      lessons: ["Liquidation price changes as unrealized P&L changes margin ratio — recalculate on each check"],
      strategies: ["Flag positions where current price is within 15% of liquidation price as high-risk"],
      failures: [],
      tools: ["get_positions", "get_account_state"],
    },
  ],
};

// ---------------------------------------------------------------------------
// Build a JSONL trace file from an EpisodeSpec
// ---------------------------------------------------------------------------

function buildTrace(agentName: string, spec: EpisodeSpec, traceId: string): AgentEvent[] {
  const sessionId = nanoid();
  const now = Date.now() - Math.floor(Math.random() * 86400000); // within last 24h
  const events: AgentEvent[] = [];

  events.push({
    id: nanoid(), timestamp: now, sessionId, agentName,
    type: "session:start",
    payload: { task: spec.task, prompt: spec.task },
    traceId,
  });

  // Tool calls
  for (let i = 0; i < spec.tools.length; i++) {
    events.push({
      id: nanoid(), timestamp: now + 1000 + i * 500, sessionId, agentName,
      type: "agent:tool_call",
      payload: { toolUse: { type: "tool_use", id: nanoid(), name: spec.tools[i], input: {} } },
      traceId,
    });
  }

  // Reasoning message (includes lessons/strategies as context for Haiku extraction)
  const reasoning = [
    spec.lessons.length ? `Key findings: ${spec.lessons.join("; ")}` : "",
    spec.strategies.length ? `Effective approaches: ${spec.strategies.join("; ")}` : "",
    spec.failures.length ? `Issues encountered: ${spec.failures.join("; ")}` : "",
  ].filter(Boolean).join("\n");

  if (reasoning) {
    events.push({
      id: nanoid(), timestamp: now + 3000, sessionId, agentName,
      type: "agent:message",
      payload: { role: "assistant", content: reasoning },
      traceId,
    });
  }

  if (spec.outcome === "failure" && spec.failures.length) {
    events.push({
      id: nanoid(), timestamp: now + 4000, sessionId, agentName,
      type: "agent:error",
      payload: { error: spec.failures[0] },
      traceId,
    });
  }

  const endType = spec.outcome === "success" ? "agent:completion" : "session:end";
  events.push({
    id: nanoid(), timestamp: now + 5000, sessionId, agentName,
    type: endType as AgentEvent["type"],
    payload: { outcome: spec.outcome, cost: 0.002 + Math.random() * 0.008 },
    traceId,
  });

  return events;
}

// ---------------------------------------------------------------------------
// Haiku LlmFn via claude-agent-sdk (uses Claude subscription)
// ---------------------------------------------------------------------------

async function haikuLlm(prompt: string): Promise<string> {
  let output = "";
  for await (const msg of query({
    prompt,
    options: {
      model: "haiku",
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  })) {
    if (msg.type === "assistant") {
      const content = (msg as any).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") output += block.text;
        }
      }
    }
  }
  return output;
}

// ---------------------------------------------------------------------------
// Simulation state
// ---------------------------------------------------------------------------

type CycleResult = PipelineResult & { cycleMs: number };

let tmpDir: string;
let tracesDir: string;
let engine: MemoryEngine;
const cycleResults: CycleResult[] = [];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "hl-sim-"));
  tracesDir = join(tmpDir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  engine = new MemoryEngine(join(tmpDir, "memory"));

  const config = deepSleepConfigSchema.parse({});
  const agentResolver = () => AGENTS.map(a => ({ name: a.name, team: a.team }));

  // --- 3 cycles --- each cycle: write traces for all agents, then run pipeline ---
  for (let cycle = 1; cycle <= 3; cycle++) {
    const cycleTracesDir = join(tracesDir, `cycle-${cycle}`);
    mkdirSync(cycleTracesDir, { recursive: true });

    for (const agent of AGENTS) {
      const corpus = EPISODE_CORPUS[agent.name] ?? [];
      // Pick episodes for this cycle — rotate through corpus
      const startIdx = ((cycle - 1) * 2) % corpus.length;
      const specs = [
        corpus[startIdx % corpus.length],
        corpus[(startIdx + 1) % corpus.length],
        corpus[(startIdx + 2) % corpus.length],
      ];

      for (const spec of specs) {
        const traceId = nanoid();
        const events = buildTrace(agent.name, spec, traceId);
        const filePath = join(cycleTracesDir, `${traceId}.jsonl`);
        writeFileSync(filePath, events.map(e => JSON.stringify(e)).join("\n"));
      }
    }

    const pipeline = new DeepSleepPipeline(
      engine,
      haikuLlm,
      cycleTracesDir,
      config,
      agentResolver,
    );

    const t0 = Date.now();
    const result = await pipeline.run();
    cycleResults.push({ ...result, cycleMs: Date.now() - t0 });
  }
}, 300000);

afterAll(async () => {
  await engine.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

describe("Trading Swarm Memory System Report", () => {

  it("Pipeline: 3-cycle accumulation", () => {
    const total = {
      traces: cycleResults.reduce((s, r) => s + r.tracesProcessed, 0),
      episodes: cycleResults.reduce((s, r) => s + r.episodesCreated, 0),
      entities: cycleResults.reduce((s, r) => s + r.entitiesExtracted, 0),
      triples: cycleResults.reduce((s, r) => s + r.triplesExtracted, 0),
      promoted: cycleResults.reduce((s, r) => s + r.triplesPromoted, 0),
      briefings: cycleResults.reduce((s, r) => s + r.briefingsGenerated, 0),
      errors: cycleResults.reduce((s, r) => s + r.stageErrors.length, 0),
      ms: cycleResults.reduce((s, r) => s + r.cycleMs, 0),
    };

    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║        TRADING SWARM MEMORY SYSTEM REPORT               ║");
    console.log("╚══════════════════════════════════════════════════════════╝\n");

    console.log("SETUP");
    console.log(`  Agents:   ${AGENTS.length} (hl-ceo, hl-market-analyst, hl-strategist, hl-risk-manager, hl-order-executor, hl-portfolio-tracker)`);
    console.log(`  Teams:    leadership, research (analyst+strategist), execution (risk+executor), ops`);
    console.log(`  Cycles:   3 pipeline runs (simulating 3 trading days)`);
    console.log(`  Episodes: ~3/agent/cycle = ${AGENTS.length * 3 * 3} total\n`);

    console.log("CUMULATIVE PIPELINE RESULTS");
    console.log(`  Traces processed:    ${total.traces}`);
    console.log(`  Episodes created:    ${total.episodes}`);
    console.log(`  Entities extracted:  ${total.entities}`);
    console.log(`  Triples extracted:   ${total.triples}`);
    console.log(`  Triples promoted:    ${total.promoted}`);
    console.log(`  Briefings generated: ${total.briefings}`);
    console.log(`  Stage errors:        ${total.errors}`);
    console.log(`  Total wall time:     ${(total.ms / 1000).toFixed(1)}s\n`);

    console.log("PER-CYCLE BREAKDOWN");
    console.log("  Cycle  Traces  Episodes  Entities  Triples  Promoted  Briefings  Time");
    console.log("  ───────────────────────────────────────────────────────────────────────");
    for (let i = 0; i < cycleResults.length; i++) {
      const r = cycleResults[i];
      console.log(
        `    ${i + 1}     ${String(r.tracesProcessed).padStart(5)}     ${String(r.episodesCreated).padStart(5)}`+
        `     ${String(r.entitiesExtracted).padStart(5)}    ${String(r.triplesExtracted).padStart(5)}`+
        `      ${String(r.triplesPromoted).padStart(5)}       ${String(r.briefingsGenerated).padStart(5)}`+
        `  ${(r.cycleMs/1000).toFixed(1)}s`
      );
    }
    console.log();

    if (total.promoted > 0) {
      console.log(`  ✓ LEARNING PROPAGATION: ${total.promoted} triples promoted across scope boundaries`);
    } else {
      console.log(`  ✗ LEARNING PROPAGATION: 0 promotions — agents not accumulating enough shared triples yet`);
    }
    console.log();
  });

  it("Per-agent episode breakdown", () => {
    const sqlite = engine.getSqlite();
    const store = new EpisodeStore(sqlite.raw);

    console.log("\nPER-AGENT EPISODES (all 3 cycles)");
    console.log("  Agent                  Team         Total  Succ  Fail  Partial");
    console.log("  ──────────────────────────────────────────────────────────────");
    for (const agent of AGENTS) {
      const eps = store.getByAgent(agent.name, 30);
      const s = eps.filter(e => e.outcome === "success").length;
      const f = eps.filter(e => e.outcome === "failure").length;
      const p = eps.filter(e => e.outcome === "partial").length;
      console.log(
        `  ${agent.name.padEnd(22)} ${agent.team.padEnd(12)} ${String(eps.length).padStart(5)}`+
        `  ${String(s).padStart(4)}  ${String(f).padStart(4)}   ${String(p).padStart(5)}`
      );
    }
    console.log();
  });

  it("Knowledge graph: entities and triples extracted", async () => {
    const kuzu = await engine.getKuzu();
    const store = await KnowledgeStore.create(kuzu);

    // Query all agents' knowledge
    const allKnowledge = new Map<string, { global: number; team: number; agent: number }>();
    for (const agent of AGENTS) {
      const teamMembers = AGENTS.filter(a => a.team === agent.team).map(a => a.name);
      const triples = await store.getByScope(agent.name, teamMembers);
      allKnowledge.set(agent.name, {
        global: triples.filter(r => r.triple.scope === "global").length,
        team:   triples.filter(r => r.triple.scope === "team").length,
        agent:  triples.filter(r => r.triple.scope === "agent").length,
      });
    }

    console.log("\nKNOWLEDGE GRAPH — visible triples per agent");
    console.log("  Agent                  Global  Team  Agent  Total");
    console.log("  ────────────────────────────────────────────────────");
    for (const agent of AGENTS) {
      const k = allKnowledge.get(agent.name)!;
      const total = k.global + k.team + k.agent;
      console.log(
        `  ${agent.name.padEnd(22)} ${String(k.global).padStart(6)}  ${String(k.team).padStart(4)}  ${String(k.agent).padStart(5)}  ${String(total).padStart(5)}`
      );
    }
    console.log();

    // Check team isolation
    const researchAlpha = await store.getByScope("hl-market-analyst", ["hl-strategist"]);
    const executionAlpha = await store.getByScope("hl-risk-manager", ["hl-order-executor"]);
    const researchTeamTriples = researchAlpha.filter(r => r.triple.scope === "team");
    const executionTeamTriples = executionAlpha.filter(r => r.triple.scope === "team");

    console.log("  Team-scoped knowledge:");
    console.log(`    research team:  ${researchTeamTriples.length} shared triples (market-analyst ↔ strategist)`);
    console.log(`    execution team: ${executionTeamTriples.length} shared triples (risk-manager ↔ order-executor)`);

    if (researchTeamTriples.length > 0) {
      console.log("  Research team shared triples (sample):");
      for (const r of researchTeamTriples.slice(0, 3)) {
        console.log(`    "${r.triple.sourceName}" → ${r.triple.predicate} → "${r.triple.targetName}" (confidence: ${r.triple.confidence.toFixed(2)})`);
      }
    }
    if (executionTeamTriples.length > 0) {
      console.log("  Execution team shared triples (sample):");
      for (const r of executionTeamTriples.slice(0, 3)) {
        console.log(`    "${r.triple.sourceName}" → ${r.triple.predicate} → "${r.triple.targetName}" (confidence: ${r.triple.confidence.toFixed(2)})`);
      }
    }
    console.log();
  });

  it("Briefing content: what agents would receive before next session", async () => {
    const kuzu = await engine.getKuzu();
    const sqlite = engine.getSqlite();
    const knowledgeStore = await KnowledgeStore.create(kuzu);
    const episodeStore = new EpisodeStore(sqlite.raw);
    const briefingStore = new BriefingStore(sqlite.raw);
    const generator = new BriefingGenerator(episodeStore, knowledgeStore, briefingStore);

    console.log("\nBRIEFINGS — pre-session context injection");

    for (const agent of AGENTS) {
      const teamMembers = AGENTS.filter(a => a.team === agent.team && a.name !== agent.name).map(a => a.name);
      const briefing = await generator.generate(agent.name, teamMembers, 800);

      if (briefing) {
        console.log(`\n  ┌─ ${agent.name} (${agent.team})`);
        const lines = briefing.split("\n").filter(l => l.trim());
        for (const line of lines.slice(0, 8)) {
          console.log(`  │ ${line}`);
        }
        if (lines.length > 8) console.log(`  │ ... (${lines.length - 8} more lines)`);
        console.log(`  └─ (${briefing.length} chars)`);
      } else {
        console.log(`\n  ✗ ${agent.name}: no briefing generated (insufficient data)`);
      }
    }
    console.log();
  });

  it("Gap analysis: what the memory system is missing", async () => {
    const analyzer = new GapAnalyzer(engine);
    const report = await analyzer.analyze();

    console.log("\nGAP ANALYSIS");
    console.log(`  Coverage:  ${report.metrics.coveragePercent}%`);
    console.log(`  Episodes:  ${report.metrics.totalEpisodes}`);
    console.log(`  Entities:  ${report.metrics.totalEntities}`);
    console.log(`  Triples:   ${report.metrics.totalTriples}`);
    console.log();

    if (report.findings.length === 0) {
      console.log("  ✓ No gaps detected\n");
    } else {
      const bySeverity = { P0: [] as string[], P1: [] as string[], P2: [] as string[], P3: [] as string[] };
      for (const f of report.findings) {
        bySeverity[f.severity].push(`${f.category}: ${f.description}`);
      }
      for (const [sev, items] of Object.entries(bySeverity)) {
        if (items.length > 0) {
          console.log(`  [${sev}] ${items.length} finding(s):`);
          for (const item of items) {
            console.log(`    • ${item}`);
          }
        }
      }
      console.log();
    }

    // Verdict
    const totalTriples = cycleResults.reduce((s, r) => s + r.triplesExtracted, 0);
    const totalPromoted = cycleResults.reduce((s, r) => s + r.triplesPromoted, 0);
    const totalErrors = cycleResults.reduce((s, r) => s + r.stageErrors.length, 0);

    console.log("VERDICT");
    if (totalErrors > 0) {
      console.log(`  ⚠ Pipeline had ${totalErrors} stage errors — investigate before production use`);
    }
    if (totalTriples === 0) {
      console.log(`  ✗ Entity extraction produced no triples — LLM extraction or schema mismatch`);
    } else if (totalTriples < 10) {
      console.log(`  ⚠ Only ${totalTriples} triples extracted from ${report.metrics.totalEpisodes} episodes — extraction needs richer episode content`);
    } else {
      console.log(`  ✓ Entity extraction working: ${totalTriples} triples from ${report.metrics.totalEpisodes} episodes`);
    }
    if (totalPromoted === 0) {
      console.log(`  ✗ No scope promotion fired — need more cycles or lower agentToTeamMinAgents threshold`);
    } else {
      console.log(`  ✓ Scope promotion working: ${totalPromoted} triples propagated`);
    }
    if (report.metrics.coveragePercent < 30) {
      console.log(`  ⚠ Coverage ${report.metrics.coveragePercent}% — knowledge graph is sparse, system learning but slowly`);
    } else {
      console.log(`  ✓ Coverage ${report.metrics.coveragePercent}% — knowledge density is healthy`);
    }
    console.log();
  });

});
