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
    max: 4,
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
  args: { agentId: string; role: string; address: string; displayName: string },
): Promise<void> {
  const addressBytes = `\\x${args.address.replace(/^0x/, "").toLowerCase()}`;
  await client.query(
    `INSERT INTO demo.agent_heartbeat (agent_id, role, address, display_name, last_seen)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (agent_id) DO UPDATE
        SET role = EXCLUDED.role,
            address = EXCLUDED.address,
            display_name = EXCLUDED.display_name,
            last_seen = now()`,
    [args.agentId, args.role, addressBytes, args.displayName],
  );
}
