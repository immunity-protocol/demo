-- Scenario 03 - Twitter-style external alert.
--
-- A community report arrives (in the live demo, via the Pipedream tweet
-- pipeline; here, we simulate the same downstream). The watcher publishes
-- an ADDRESS antibody for the reported wallet. Within seconds it gossips
-- across the AXL mesh and every agent has it.
--
-- Narrative beat: "Someone tweeted about a drainer. The watcher saw it.
-- Within five seconds it's in the registry, propagated, and every agent
-- on the network is now immune to it - without any of them ever seeing the
-- tweet."
INSERT INTO demo.commands (agent_id, command_type, payload) VALUES
  ('watcher-1',
   'external_threat_alert',
   $json$
   {
     "address":    "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
     "severity":   91,
     "verdict":    "MALICIOUS",
     "reasoning":  "Drainer wallet flagged by community after $50k loss reported on Twitter - phishing-kit derivative.",
     "source":     "scenario",
     "source_url": "https://twitter.com/0ximmunity/status/demo-replay"
   }
   $json$::jsonb);
