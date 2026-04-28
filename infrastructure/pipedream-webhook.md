# Pipedream webhook: Twitter -> threat-report

The watcher agent (`watcher-1`) reacts to community threat reports posted on Twitter. The pipeline is:

```
tweet (mentions @0ximmunity, opens with "Threat report:")
  -> Pipedream workflow
    -> POST https://immunity-app.fly.dev/v1/internal/threat-report
       Header: X-CRON-TOKEN: <secret>
       Body: { address, severity, verdict, reasoning, source_url? }
       -> app inserts demo.commands row for watcher-1
          -> watcher-1 publishes ADDRESS antibody on next dequeue tick
             -> antibody propagates via AXL gossip to all agents
```

## Pipedream workflow

1. **Trigger**: Twitter "New Mention" of `@0ximmunity`.
2. **Filter step** (Node code):
   ```js
   const tweet = steps.trigger.event;
   const text = (tweet.text || '').trim();
   if (!text.toLowerCase().startsWith('threat report:')) {
     return $.flow.exit('not a threat report');
   }
   const addrMatch = text.match(/0x[a-fA-F0-9]{40}/);
   if (!addrMatch) {
     return $.flow.exit('no address in tweet');
   }
   const sevMatch = text.match(/severity[:\s]+(\d{1,3})/i);
   return {
     address: addrMatch[0].toLowerCase(),
     severity: sevMatch ? parseInt(sevMatch[1], 10) : 80,
     reasoning: text,
     source_url: `https://twitter.com/${tweet.user.screen_name}/status/${tweet.id_str}`,
   };
   ```
3. **HTTP step**:
   - Method: `POST`
   - URL: `https://immunity-app.fly.dev/v1/internal/threat-report`
   - Headers:
     - `Content-Type: application/json`
     - `X-CRON-TOKEN: <CRON_TOKEN secret from app .env>`
   - Body: pass the parsed object from step 2.

## Endpoint contract

`POST /v1/internal/threat-report` (defined in `app/Controllers/Api/Public/Internal/ThreatReportController.php`).

Body schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `address` | string | yes | 0x-prefixed 20-byte hex |
| `severity` | int | yes | 0-100 |
| `verdict` | string | no | `MALICIOUS` (default) or `SUSPICIOUS` |
| `reasoning` | string | yes | Non-empty free text shown in explorer |
| `source_url` | string | no | Surfaced as evidence link |

Returns `202 Accepted` with `{command_id, agent_id}` on success.

## Demo fallback

For the live pitch, prefer the **Send Twitter Alert** button in `/playground` Section 3 over the Pipedream pipeline. It hits the same downstream code path without the network round-trip through Twitter -> Pipedream. Pipedream is for the "we accept community reports in real time" narrative; the button is what you click on stage.
