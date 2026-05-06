// Agent: retrieve trading performance for a pool from GeckoTerminal.
//
// The sandbox has zero permissions. All HTTP calls happen parent-side
// through tools that hit the public GeckoTerminal v2 API (no key needed).
//
// Run via CLI:
//   env OPENAI_API_KEY=... deno run -A src/cli.ts \
//     --agent examples/gecko_terminal.ts -- \
//     "Trading performance for the WETH/USDC 0.05% pool on eth: 0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"
//
// Direct (no CLI):
//   env OPENAI_API_KEY=... deno run -A examples/gecko_terminal.ts

import { Agent, defineTool } from "../src/mod.ts";
import { openai } from "npm:@ai-sdk/openai@2";
import { z } from "zod";
import type { AgentFactoryInput } from "../src/cli.ts";

const GT = "https://api.geckoterminal.com/api/v2";

async function gt<T>(path: string): Promise<T> {
  const r = await fetch(`${GT}${path}`, {
    headers: { "Accept": "application/json;version=20230302" },
  });
  if (!r.ok) {
    throw new Error(`GeckoTerminal ${r.status} on ${path}: ${await r.text()}`);
  }
  return await r.json() as T;
}

const network = z.string().min(1).describe(
  "GeckoTerminal network id (e.g. 'eth', 'bsc', 'polygon_pos', 'base', 'arbitrum', 'solana').",
);
const poolAddress = z.string().min(1).describe(
  "Pool contract address on that network (case-insensitive).",
);

const getPoolPerformance = defineTool({
  name: "getPoolPerformance",
  description:
    "Fetch a pool's trading performance summary: price, FDV, market cap, " +
    "price changes (5m/15m/30m/1h/6h/24h), volume, buy/sell counts, and reserve.",
  schema: z.object({ network, poolAddress }),
  handler: async ({ network, poolAddress }) => {
    const data = await gt<{
      data: { attributes: Record<string, unknown> };
    }>(`/networks/${network}/pools/${poolAddress}`);
    const a = data.data.attributes;
    return {
      name: a.name,
      address: a.address,
      poolCreatedAt: a.pool_created_at,
      feePercentage: a.pool_fee_percentage,
      priceUsd: a.base_token_price_usd,
      quoteTokenPriceUsd: a.quote_token_price_usd,
      fdvUsd: a.fdv_usd,
      marketCapUsd: a.market_cap_usd,
      reserveInUsd: a.reserve_in_usd,
      lockedLiquidityPercentage: a.locked_liquidity_percentage,
      priceChangePercentage: a.price_change_percentage,
      transactions: a.transactions,
      volumeUsd: a.volume_usd,
    };
  },
});

const getPoolOhlcv = defineTool({
  name: "getPoolOhlcv",
  description:
    "Fetch OHLCV candles for a pool. Each candle is [unixTs, open, high, low, close, volumeUsd].",
  schema: z.object({
    network,
    poolAddress,
    timeframe: z.enum(["day", "hour", "minute"]).default("hour"),
    aggregate: z.number().int().min(1).max(60).default(1).describe(
      "Bucket size within the timeframe (e.g. timeframe=minute, aggregate=15 → 15m candles).",
    ),
    limit: z.number().int().min(1).max(1000).default(48),
  }),
  handler: async ({ network, poolAddress, timeframe, aggregate, limit }) => {
    const data = await gt<{
      data: { attributes: { ohlcv_list: Array<[number, number, number, number, number, number]> } };
    }>(
      `/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}` +
        `?aggregate=${aggregate}&limit=${limit}`,
    );
    return {
      timeframe,
      aggregate,
      candles: data.data.attributes.ohlcv_list.map(([ts, o, h, l, c, v]) => ({
        ts,
        iso: new Date(ts * 1000).toISOString(),
        open: o,
        high: h,
        low: l,
        close: c,
        volumeUsd: v,
      })),
    };
  },
});

const getPoolTrades = defineTool({
  name: "getPoolTrades",
  description:
    "Fetch recent trades for a pool. Useful for inspecting current trading activity beyond aggregates.",
  schema: z.object({
    network,
    poolAddress,
    minVolumeUsd: z.number().min(0).default(0).describe(
      "Filter out trades smaller than this USD value.",
    ),
  }),
  handler: async ({ network, poolAddress, minVolumeUsd }) => {
    const data = await gt<{
      data: Array<{ attributes: Record<string, unknown> }>;
    }>(
      `/networks/${network}/pools/${poolAddress}/trades` +
        (minVolumeUsd > 0 ? `?trade_volume_in_usd_greater_than=${minVolumeUsd}` : ""),
    );
    return data.data.map((t) => ({
      blockTimestamp: t.attributes.block_timestamp,
      kind: t.attributes.kind,
      priceUsd: t.attributes.price_to_in_usd ?? t.attributes.price_from_in_usd,
      volumeUsd: t.attributes.volume_in_usd,
      fromTokenAmount: t.attributes.from_token_amount,
      toTokenAmount: t.attributes.to_token_amount,
      txHash: t.attributes.tx_hash,
    }));
  },
});

export default function createAgent(input: AgentFactoryInput): Agent {
  return new Agent({
    model: openai("gpt-5-mini"),
    task: input.task,
    sessionId: input.sessionId,
    onStep: input.onStep,
    resumeHistory: input.resumeHistory,
    tools: [getPoolPerformance, getPoolOhlcv, getPoolTrades],
    // Sandbox has zero permissions. All network access lives in the tools.
    permissions: {},
    maxSteps: 5,
    experimental: input.asyncWakeups ? { asyncWakeups: true } : undefined,
  });
}

if (import.meta.main) {
  const result = await createAgent({
    task:
      "Give me a trading performance summary for the WETH/USDC 0.05% pool on " +
      "Ethereum (network='eth', poolAddress='0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640'). " +
      "Include current price, 24h volume, 24h price change, and a brief read on " +
      "the last 24h of hourly candles (trend, volatility).",
  }).run();
  console.log("RESULT:", JSON.stringify(result, null, 2));
}
