/**
 * Invariant check for the incident catalog.
 *
 * For every variant in every family, the family's canonical marker MUST
 * appear (case-insensitive substring) somewhere in the variant's flattened
 * context. This is what makes the SDK's SemanticMatcher dedupe the
 * variants to a single antibody once any one of them publishes: Tier-1
 * cache lookups are exact substring scans against the same flattened text.
 *
 * Running: `npm run test:incidents`
 *
 * Exits non-zero on the first failure.
 */
import {
  INCIDENT_FAMILIES,
  totalVariantCount,
  type IncidentVariant,
} from "../agents/src/data/incidents.js";

interface Failure {
  family: string;
  variant: string;
  reason: string;
}

function flatten(v: IncidentVariant): string {
  const ctx = v.context;
  const parts: string[] = [];
  for (const turn of ctx.conversation ?? []) parts.push(turn.content);
  for (const t of ctx.toolTrace ?? []) parts.push(t.tool, JSON.stringify(t.args));
  for (const s of ctx.sources ?? []) {
    parts.push(s.url);
    if (s.extractedText) parts.push(s.extractedText);
  }
  if (ctx.counterparty) {
    parts.push(ctx.counterparty.id);
    if (ctx.counterparty.ens) parts.push(ctx.counterparty.ens);
  }
  return parts.join(" ");
}

function main(): void {
  const failures: Failure[] = [];
  const seenIds = new Set<string>();

  for (const family of INCIDENT_FAMILIES) {
    if (family.variants.length === 0) {
      failures.push({ family: family.id, variant: "(none)", reason: "family has no variants" });
      continue;
    }
    if (family.marker.length < 8) {
      failures.push({ family: family.id, variant: "(family)", reason: `marker too short: "${family.marker}"` });
    }
    for (const variant of family.variants) {
      if (seenIds.has(variant.id)) {
        failures.push({ family: family.id, variant: variant.id, reason: "duplicate variant id across catalog" });
      }
      seenIds.add(variant.id);

      const haystack = flatten(variant).toLowerCase();
      const needle = family.marker.toLowerCase();
      if (!haystack.includes(needle)) {
        failures.push({
          family: family.id,
          variant: variant.id,
          reason: `marker "${family.marker}" not found in flattened context`,
        });
      }
    }
  }

  const total = totalVariantCount();
  if (failures.length > 0) {
    console.error(`incident catalog invariant FAILED (${failures.length} issues):`);
    for (const f of failures) {
      console.error(`  - ${f.family} / ${f.variant}: ${f.reason}`);
    }
    process.exit(1);
  }
  console.log(`incident catalog OK: ${INCIDENT_FAMILIES.length} families, ${total} variants, all markers present.`);
}

main();
