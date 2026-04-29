/**
 * Minimal AXL HTTP client for the demo fleet.
 *
 * Each agent's AXL spoke runs as a sidecar in the docker compose stack and
 * exposes its API on AXL_URL (default `http://axl-spoke:9002`). Three
 * primitives are enough for our demo:
 *
 *   - topology()  : read our own peer pubkey at boot
 *   - send()      : wolf sends a social_dm to a target trader
 *   - recv()      : trader drains its inbox each tick
 *
 * See the AXL skill notes in this repo for the X-From-Peer-Id gotcha:
 * the value on /recv is a TRUNCATED PREFIX of the sender's pubkey
 * (padded with 0xff), NOT the full pubkey, and CANNOT be used as a
 * destination on a follow-up /send. Resolve sender identity by
 * prefix-matching against a known directory (we use demo.agent_heartbeat
 * for this — the axl_peer_id column).
 */

export interface AxlTopology {
  our_ipv6: string;
  our_public_key: string;
  peers: Array<{ public_key: string; up: boolean; inbound: boolean; uri: string }>;
  tree: Array<{ public_key: string; parent: string; sequence: number }>;
}

export interface AxlEnvelope<T = unknown> {
  app: "immunity-demo";
  v: number;
  kind: "social_dm";
  payload: T;
}

export class AxlClient {
  constructor(private readonly baseUrl: string) {}

  async topology(): Promise<AxlTopology> {
    const r = await fetch(`${this.baseUrl}/topology`);
    if (!r.ok) throw new Error(`axl topology failed: ${r.status}`);
    return r.json() as Promise<AxlTopology>;
  }

  /**
   * Fire-and-forget send to a specific peer. Throws on dial errors (offline
   * peer) — callers may want to soft-fail with a warn log, since the demo
   * shouldn't crash an agent because a target trader is briefly down.
   */
  async send(destPubkey: string, body: Uint8Array): Promise<number> {
    // Node's fetch accepts Uint8Array but TS lib.dom.d.ts BodyInit is too
    // strict; cast at the boundary rather than widen the parameter type.
    const r = await fetch(`${this.baseUrl}/send`, {
      method: "POST",
      headers: {
        "X-Destination-Peer-Id": destPubkey,
        "Content-Type": "application/octet-stream",
      },
      body: body as unknown as BodyInit,
    });
    if (!r.ok) throw new Error(`axl send failed: ${r.status} ${await r.text()}`);
    return Number(r.headers.get("x-sent-bytes") ?? 0);
  }

  /**
   * Drain one inbound message. 204 means the queue is empty. Returns the
   * sender's truncated peer-id (resolve via peerIdMatches against the
   * heartbeat table) and the raw body bytes.
   */
  async recv(): Promise<{ from: string; body: Uint8Array } | null> {
    const r = await fetch(`${this.baseUrl}/recv`);
    if (r.status === 204) return null;
    if (!r.ok) throw new Error(`axl recv failed: ${r.status}`);
    return {
      from: r.headers.get("x-from-peer-id") ?? "",
      body: new Uint8Array(await r.arrayBuffer()),
    };
  }
}

/**
 * Match an /recv X-From-Peer-Id header against a known full pubkey from the
 * heartbeat directory. The header is the sender's pubkey truncated to its
 * IPv6-encodable prefix and right-padded with 0xff bytes; the last
 * non-0xff byte has mixed bits and is unreliable. Strip trailing 0xff,
 * drop the last byte, prefix-match the remainder.
 */
export function peerIdMatches(fromHeader: string, fullPubkeyHex: string): boolean {
  if (!fromHeader || !fullPubkeyHex) return false;
  let trimmed = fromHeader.toLowerCase();
  while (trimmed.length >= 2 && trimmed.slice(-2) === "ff") {
    trimmed = trimmed.slice(0, -2);
  }
  if (trimmed.length < 4) return false;
  const prefix = trimmed.slice(0, -2);
  return fullPubkeyHex.toLowerCase().startsWith(prefix);
}

export function encodeEnvelope<T>(env: AxlEnvelope<T>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env));
}

export function decodeEnvelope<T>(bytes: Uint8Array): AxlEnvelope<T> | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (
      typeof obj === "object" &&
      obj !== null &&
      (obj as { app?: unknown }).app === "immunity-demo" &&
      typeof (obj as { kind?: unknown }).kind === "string"
    ) {
      return obj as AxlEnvelope<T>;
    }
    return null;
  } catch {
    return null;
  }
}
