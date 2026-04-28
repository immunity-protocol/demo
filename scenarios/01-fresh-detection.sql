-- Scenario 01 — Fresh detection.
--
-- A wolf attempts a novel attack against a fresh random address with rich
-- context. The cache misses; the TEE evaluates the conversation + tx; the
-- check() result auto-mints an antibody if the verdict is malicious. Within
-- a few seconds the new antibody propagates to every other agent's cache.
--
-- Narrative beat: "Watch — the network has never seen this attack before.
-- It thinks for ten seconds, decides, and now everyone is protected."
--
-- Idempotent: each apply enqueues one fresh command for wolf-1.
INSERT INTO demo.commands (agent_id, command_type, payload) VALUES
  ('wolf-1',
   'attack',
   $json$
   {
     "method":     "drain",
     "novel":      true,
     "amount_usd": 12000,
     "context":    "Unsolicited DM from a new contact: 'send 0.05 ETH to bootstrap the airdrop, you'll get 5x back in 10 min'. Their wallet was created an hour ago."
   }
   $json$::jsonb);
