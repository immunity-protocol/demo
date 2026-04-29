import { Pool, type PoolClient } from "pg";

export interface Command {
  id: string;
  agentId: string;
  commandType: string;
  payload: Record<string, unknown>;
  scheduledAt: string;
}

export interface FleetState {
  ambientPaused: boolean;
  pausedAt: string | null;
}

export interface CommandResult {
  status: "completed" | "failed";
  detail?: Record<string, unknown> | null;
}

let pool: Pool | null = null;

export function connectPool(databaseUrl: string): Pool {
  if (pool !== null) {
    return pool;
  }
  pool = new Pool({
    connectionString: databaseUrl,
    // Packed-fleet deployment runs all 60 agents on one Fly machine; with
    // pool max=4 we'd reserve 240 conns and saturate the Fly Postgres
    // ceiling. max=2 gives 120, which fits comfortably alongside the
    // indexer / app / api / relayer connections.
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "immunity-demo-agent",
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}

/**
 * Pop the oldest pending command for the given agent. Uses
 * SELECT … FOR UPDATE SKIP LOCKED inside a transaction so multiple agent
 * containers (e.g. after a restart that overlaps) cannot double-execute the
 * same row. Returns null when the queue is empty for this agent.
 */
export async function dequeueCommand(client: Pool | PoolClient, agentId: string): Promise<Command | null> {
  const conn = await ("connect" in client ? client.connect() : Promise.resolve(client as PoolClient));
  const isOwned = "release" in conn && client !== conn;
  try {
    await conn.query("BEGIN");
    const res = await conn.query<{
      id: string;
      agent_id: string;
      command_type: string;
      payload: Record<string, unknown>;
      scheduled_at: string;
    }>(
      `SELECT id, agent_id, command_type, payload, scheduled_at
         FROM demo.commands
        WHERE agent_id = $1 AND picked_up_at IS NULL
        ORDER BY scheduled_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [agentId],
    );
    const row = res.rows[0];
    if (row === undefined) {
      await conn.query("COMMIT");
      return null;
    }
    await conn.query(
      `UPDATE demo.commands SET picked_up_at = now() WHERE id = $1`,
      [row.id],
    );
    await conn.query("COMMIT");
    return {
      id: row.id,
      agentId: row.agent_id,
      commandType: row.command_type,
      payload: row.payload,
      scheduledAt: row.scheduled_at,
    };
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (isOwned) {
      (conn as PoolClient).release();
    }
  }
}

export async function markCommandComplete(
  client: Pool | PoolClient,
  commandId: string,
  result: CommandResult,
): Promise<void> {
  await client.query(
    `UPDATE demo.commands
        SET executed_at = now(),
            result_status = $2,
            result_detail = $3::jsonb
      WHERE id = $1`,
    [commandId, result.status, result.detail ? JSON.stringify(result.detail) : null],
  );
}

export async function getFleetState(client: Pool | PoolClient): Promise<FleetState> {
  const res = await client.query<{ ambient_paused: boolean; paused_at: string | null }>(
    `SELECT ambient_paused, paused_at FROM demo.fleet_state WHERE id = 1`,
  );
  const row = res.rows[0];
  if (row === undefined) {
    return { ambientPaused: false, pausedAt: null };
  }
  return { ambientPaused: row.ambient_paused, pausedAt: row.paused_at };
}

export async function upsertHeartbeat(
  client: Pool | PoolClient,
  args: { agentId: string; role: string; address: string; displayName: string; axlPeerId?: string | null },
): Promise<void> {
  const addressBytes = `\\x${args.address.replace(/^0x/, "").toLowerCase()}`;
  // axl_peer_id is the agent's full ed25519 pubkey from /topology. Other
  // agents read it back via getAxlPeerIdFor() to address /send. The column
  // is nullable: agents that haven't yet completed topology (or are running
  // pre-Phase-4 builds) leave it null; the wolf social-dm code skips
  // targets whose peer-id is null.
  await client.query(
    `INSERT INTO demo.agent_heartbeat (agent_id, role, address, display_name, axl_peer_id, last_seen)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (agent_id) DO UPDATE
        SET role = EXCLUDED.role,
            address = EXCLUDED.address,
            display_name = EXCLUDED.display_name,
            axl_peer_id = COALESCE(EXCLUDED.axl_peer_id, demo.agent_heartbeat.axl_peer_id),
            last_seen = now()`,
    [args.agentId, args.role, addressBytes, args.displayName, args.axlPeerId ?? null],
  );
}

export interface OnlinePeer {
  agentId: string;
  role: string;
  axlPeerId: string;
  displayName: string;
}

const ONLINE_WINDOW_SECONDS = 180;

/**
 * Online traders that have published an axl_peer_id. Used by wolves to
 * pick a target for AXL DM attacks. Excludes the caller's own agent_id.
 */
export async function listOnlineTargetTraders(
  client: Pool | PoolClient,
  excludeAgentId: string,
): Promise<OnlinePeer[]> {
  const res = await client.query<{ agent_id: string; role: string; axl_peer_id: string; display_name: string }>(
    `SELECT agent_id, role, axl_peer_id, display_name
       FROM demo.agent_heartbeat
      WHERE role = 'trader'
        AND agent_id <> $1
        AND axl_peer_id IS NOT NULL
        AND last_seen >= now() - ($2 || ' seconds')::interval`,
    [excludeAgentId, String(ONLINE_WINDOW_SECONDS)],
  );
  return res.rows.map((r) => ({
    agentId: r.agent_id,
    role: r.role,
    axlPeerId: r.axl_peer_id,
    displayName: r.display_name,
  }));
}

/**
 * Pick a publisher to receive a queued external_threat_alert command.
 * Round-robin via random pick from online publishers. Returns null when
 * no publisher is online (the playground/webhook caller surfaces an error).
 */
export async function pickOnlinePublisher(client: Pool | PoolClient): Promise<string | null> {
  const res = await client.query<{ agent_id: string }>(
    `SELECT agent_id
       FROM demo.agent_heartbeat
      WHERE role = 'publisher'
        AND last_seen >= now() - ($1 || ' seconds')::interval
      ORDER BY random()
      LIMIT 1`,
    [String(ONLINE_WINDOW_SECONDS)],
  );
  return res.rows[0]?.agent_id ?? null;
}

export interface SocialFeedRow {
  id: string;
  source: string;
  url: string;
  content: string;
  postedByAgentId: string | null;
}

/**
 * Insert a wolf-authored post into demo.social_feed. The trader scan path
 * picks unread rows up; the indirect-injection content fires when the
 * marker substring matches a known SEMANTIC antibody.
 */
export async function insertSocialFeedPost(
  client: Pool | PoolClient,
  args: { source: string; url: string; content: string; postedByAgentId: string },
): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO demo.social_feed (source, url, content, posted_by_agent_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text`,
    [args.source, args.url, args.content, args.postedByAgentId],
  );
  return res.rows[0]!.id;
}

/**
 * Pick one unread social_feed row for this agent. Marks it read in the same
 * transaction so concurrent ticks don't double-evaluate the same post.
 * Returns null when there's nothing fresh to read.
 */
export interface ActivityRow {
  agentId: string;
  role: string;
  displayName: string;
  actionType: string;
  actionSummary: string;
  status: "allow" | "block" | "novel" | "error" | "info";
  antibodyImmId?: string | null;
  txHash?: string | null;
  target?: string | null;
  family?: string | null;
  details?: Record<string, unknown>;
}

/**
 * Insert one row into demo.agent_activity. Used by every ambient/command/inbox
 * call site to surface what the agent just did on the dashboard's live feed.
 *
 * Errors are logged and swallowed by the caller wrapper (`bindRecordActivity`).
 * This keeps the demo responsive — a slow or unreachable Postgres should not
 * block an agent's tick or crash the process.
 */
export async function insertAgentActivity(
  client: Pool | PoolClient,
  row: ActivityRow,
): Promise<void> {
  await client.query(
    `INSERT INTO demo.agent_activity
       (agent_id, role, display_name, action_type, action_summary, status,
        antibody_imm_id, tx_hash, target, family, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
    [
      row.agentId,
      row.role,
      row.displayName,
      row.actionType,
      row.actionSummary,
      row.status,
      row.antibodyImmId ?? null,
      row.txHash ?? null,
      row.target ?? null,
      row.family ?? null,
      row.details ? JSON.stringify(row.details) : null,
    ],
  );
}

export async function pickUnreadSocialPost(
  client: Pool | PoolClient,
  agentId: string,
): Promise<SocialFeedRow | null> {
  const conn = await ("connect" in client ? client.connect() : Promise.resolve(client as PoolClient));
  const isOwned = "release" in conn && client !== conn;
  try {
    await conn.query("BEGIN");
    const res = await conn.query<{
      id: string;
      source: string;
      url: string;
      content: string;
      posted_by_agent_id: string | null;
    }>(
      `SELECT sf.id::text AS id, sf.source, sf.url, sf.content, sf.posted_by_agent_id
         FROM demo.social_feed sf
        WHERE NOT EXISTS (
                SELECT 1 FROM demo.social_feed_read sr
                 WHERE sr.agent_id = $1 AND sr.feed_id = sf.id
              )
        ORDER BY sf.posted_at DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [agentId],
    );
    const row = res.rows[0];
    if (row === undefined) {
      await conn.query("COMMIT");
      return null;
    }
    await conn.query(
      `INSERT INTO demo.social_feed_read (agent_id, feed_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
      [agentId, row.id],
    );
    await conn.query("COMMIT");
    return {
      id: row.id,
      source: row.source,
      url: row.url,
      content: row.content,
      postedByAgentId: row.posted_by_agent_id,
    };
  } catch (err) {
    await conn.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (isOwned) (conn as PoolClient).release();
  }
}
