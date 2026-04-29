import type { AmbientContext } from "../context.js";
import { AxlClient, encodeEnvelope } from "../axl/client.js";
import {
  INCIDENT_FAMILIES,
  type IncidentFamily,
  type IncidentVariant,
} from "../data/incidents.js";
import { insertSocialFeedPost, listOnlineTargetTraders, type OnlinePeer } from "../db.js";

/**
 * Shared A2A attack primitives used by:
 *  - wolf ambient (probabilistic), see ambient/wolf.ts
 *  - operator-driven `attack` command in modes axl_dm / social_feed_post,
 *    see commands/attack.ts
 *
 * Each helper picks an incident variant from the catalog (filtered by the
 * vector that fits the channel: conversation/tool_trace for AXL DMs,
 * sources for social-feed posts) and either /sends an envelope or inserts
 * a row in demo.social_feed.
 */

let cachedAxl: AxlClient | null = null;
function getAxl(): AxlClient {
  if (cachedAxl) return cachedAxl;
  const url = process.env.AXL_URL;
  if (!url) throw new Error("AXL_URL not set");
  cachedAxl = new AxlClient(url);
  return cachedAxl;
}

export interface PickIncidentOpts {
  familyId?: string;
  /** Preferred vector(s) for this channel. */
  vectors: ReadonlyArray<IncidentVariant["vector"]>;
}

export function pickIncidentForChannel(opts: PickIncidentOpts): { family: IncidentFamily; variant: IncidentVariant } | null {
  const families = opts.familyId
    ? INCIDENT_FAMILIES.filter((f) => f.id === opts.familyId)
    : INCIDENT_FAMILIES;
  const candidates = families.flatMap((f) =>
    f.variants.filter((v) => opts.vectors.includes(v.vector)).map((v) => ({ family: f, variant: v })),
  );
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

export interface AxlDmResult {
  status: "sent" | "no-target" | "no-incident" | "send-failed";
  family?: IncidentFamily;
  variant?: IncidentVariant;
  target?: OnlinePeer;
  error?: string;
}

/**
 * Send a single social_dm envelope to a chosen or randomly-picked online
 * trader. If `targetAgentId` is provided and the agent isn't online with a
 * peer-id, returns no-target rather than picking a different one (operator
 * commands should target a specific agent).
 */
export async function sendAxlDm(
  ctx: AmbientContext,
  opts: { familyId?: string; targetAgentId?: string },
): Promise<AxlDmResult> {
  const pick = pickIncidentForChannel({
    vectors: ["conversation", "tool_trace"],
    ...(opts.familyId !== undefined ? { familyId: opts.familyId } : {}),
  });
  if (!pick) return { status: "no-incident" };
  const { family, variant } = pick;

  let target: OnlinePeer | null = null;
  let candidates: OnlinePeer[];
  try {
    candidates = await listOnlineTargetTraders(ctx.pool, ctx.slot.agentId);
  } catch (err) {
    return { status: "send-failed", error: String(err) };
  }
  if (opts.targetAgentId) {
    target = candidates.find((c) => c.agentId === opts.targetAgentId) ?? null;
    if (!target) return { status: "no-target", family, variant };
  } else {
    if (candidates.length === 0) return { status: "no-target", family, variant };
    target = candidates[Math.floor(Math.random() * candidates.length)]!;
  }

  const body = encodeEnvelope({
    app: "immunity-demo",
    v: 1,
    kind: "social_dm",
    payload: {
      family_id: family.id,
      variant_id: variant.id,
      surface: variant.surface,
      context: variant.context,
    },
  });

  try {
    await getAxl().send(target.axlPeerId, body);
    return { status: "sent", family, variant, target };
  } catch (err) {
    return { status: "send-failed", family, variant, target, error: String(err) };
  }
}

export interface SocialPostResult {
  status: "posted" | "no-incident" | "post-failed";
  family?: IncidentFamily;
  variant?: IncidentVariant;
  feedId?: string;
  source?: string;
  url?: string;
  error?: string;
}

export async function postSocialFeed(
  ctx: AmbientContext,
  opts: { familyId?: string },
): Promise<SocialPostResult> {
  const pick = pickIncidentForChannel({
    vectors: ["sources"],
    ...(opts.familyId !== undefined ? { familyId: opts.familyId } : {}),
  });
  if (!pick) return { status: "no-incident" };
  const { family, variant } = pick;

  const sources = variant.context.sources ?? [];
  if (sources.length === 0) return { status: "no-incident", family, variant };
  const first = sources[0]!;
  const content = sources
    .map((s) => s.extractedText ?? "")
    .filter((s) => s.length > 0)
    .join("\n\n---\n\n");
  if (!content) return { status: "no-incident", family, variant };

  const sourceKind = inferSourceKind(first.url);
  try {
    const id = await insertSocialFeedPost(ctx.pool, {
      source: sourceKind,
      url: first.url,
      content,
      postedByAgentId: ctx.slot.agentId,
    });
    return { status: "posted", family, variant, feedId: id, source: sourceKind, url: first.url };
  } catch (err) {
    return { status: "post-failed", family, variant, error: String(err) };
  }
}

function inferSourceKind(url: string): string {
  if (url.startsWith("https://twitter.")) return "twitter";
  if (url.startsWith("https://reddit.")) return "reddit";
  if (url.startsWith("https://github.com")) return "github";
  if (url.startsWith("https://discord")) return "discord";
  if (url.startsWith("https://t-archive.")) return "telegram";
  if (url.startsWith("https://stackoverflow.")) return "stackoverflow";
  if (url.startsWith("https://slowmist.")) return "blog";
  return "web";
}
