-- Scenario 02 - Cache replay.
--
-- A different wolf attempts an attack against an address the network already
-- knows about (Atomic Wallet drainer, seeded as IMM-2026-NNNN at startup).
-- The AddressMatcher hits in microseconds - no TEE round-trip, just a cache
-- block.
--
-- Narrative beat: "Same kind of attack. Different attacker. Different
-- target. But the network has the antibody now - block in milliseconds.
-- The first agent paid the cost. Everyone else benefits forever."
--
-- Run this immediately after scenario 01 (or any time after the seeded
-- threats have published) for the cleanest cache-vs-novel contrast.
INSERT INTO demo.commands (agent_id, command_type, payload) VALUES
  ('wolf-2',
   'attack',
   $json$
   {
     "method":     "drain",
     "target":     "tag:atomic-drainer-1",
     "amount_usd": 8000,
     "context":    "Counterparty insists the funds need to move now to avoid a 'seizure window'."
   }
   $json$::jsonb);
