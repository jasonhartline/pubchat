#!/usr/bin/env node

const API_BASE =
  process.env.CLOUDFLARE_API_BASE ?? "https://api.cloudflare.com/client/v4";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const DEFAULT_ZONE_NAME = "pubchat.org";
const MANAGED_REF_PREFIX = "pubchat-";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const listOnly = args.has("--list");

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

const zoneName = process.env.CLOUDFLARE_ZONE_NAME ?? DEFAULT_ZONE_NAME;
const host = process.env.PUBCHAT_HOST ?? zoneName;

const rateLimit = {
  period: intEnv("PUBCHAT_RATE_LIMIT_PERIOD", 10),
  requestsPerPeriod: intEnv("PUBCHAT_RATE_LIMIT_REQUESTS", 40),
  mitigationTimeout: intEnv("PUBCHAT_RATE_LIMIT_MITIGATION", 10),
};

const desiredRulesets = [
  {
    phase: "http_request_firewall_custom",
    name: "PubChat custom firewall rules",
    description: "Rules managed by PubChat command-line security setup.",
    rules: [
      {
        ref: "pubchat-block-obvious-probes",
        description: "PubChat: block obvious non-app probes",
        expression: and([
          hostExpression(host),
          or([
            pathContains("/.aws"),
            pathContains("/.DS_Store"),
            pathContains("/.env"),
            pathContains("/.git"),
            pathContains("/actuator"),
            pathContains("/cgi-bin/"),
            pathContains("/phpmyadmin"),
            pathContains("/vendor/phpunit"),
            pathContains("/wp-admin"),
            pathContains("/wp-login.php"),
            pathContains("/xmlrpc.php"),
          ]),
        ]),
        action: "block",
        enabled: true,
      },
    ],
  },
  {
    phase: "http_ratelimit",
    name: "PubChat rate limiting rules",
    description: "Rate limiting rules managed by PubChat command-line security setup.",
    rules: [
      {
        ref: "pubchat-rate-limit-dynamic-routes",
        description: "PubChat: rate limit dynamic routes",
        expression: and([
          hostExpression(host),
          or([
            'starts_with(http.request.uri.path, "/chat/")',
            'starts_with(http.request.uri.path, "/at/")',
            '(http.request.uri.path eq "/open")',
          ]),
        ]),
        action: "block",
        ratelimit: {
          characteristics: ["cf.colo.id", "ip.src"],
          period: rateLimit.period,
          requests_per_period: rateLimit.requestsPerPeriod,
          mitigation_timeout: rateLimit.mitigationTimeout,
          requests_to_origin: true,
        },
        enabled: true,
      },
    ],
  },
];

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  if (!TOKEN) {
    throw new Error("Set CLOUDFLARE_API_TOKEN before running this script.");
  }

  validateHost(host);

  const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? await lookupZoneId(zoneName);
  console.log(`Zone: ${zoneName} (${zoneId})`);
  console.log(apply ? "Mode: apply" : listOnly ? "Mode: list" : "Mode: dry-run");

  for (const desired of desiredRulesets) {
    await syncRuleset(zoneId, desired);
  }

  if (!apply && !listOnly) {
    console.log("");
    console.log("Dry run only. Re-run with --apply to make changes.");
  }
}

async function syncRuleset(zoneId, desired) {
  console.log("");
  console.log(`Phase: ${desired.phase}`);

  const current = await getEntrypoint(zoneId, desired.phase);

  if (listOnly) {
    printExistingRules(current);
    return;
  }

  if (!current) {
    console.log(`Would create entry point ruleset with ${desired.rules.length} rule(s).`);
    printDesiredRules(desired.rules);

    if (!apply) return;

    const created = await api(`/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: {
        name: desired.name,
        description: desired.description,
        kind: "zone",
        phase: desired.phase,
        rules: desired.rules,
      },
    });

    console.log(`Created ruleset ${created.id} with ${created.rules?.length ?? 0} rule(s).`);
    return;
  }

  const currentRules = current.rules ?? [];
  const desiredByRef = new Map(desired.rules.map(rule => [rule.ref, rule]));
  const managedRules = currentRules.filter(isManagedRule);
  const actions = [];

  for (const rule of desired.rules) {
    const existing = currentRules.find(currentRule =>
      currentRule.ref === rule.ref ||
      currentRule.description === rule.description
    );

    if (existing && rulesEquivalent(existing, rule)) {
      continue;
    }

    actions.push({
      kind: existing ? "patch" : "create",
      existing,
      rule,
    });
  }

  for (const rule of managedRules) {
    if (!desiredByRef.has(rule.ref)) {
      actions.push({ kind: "delete", existing: rule });
    }
  }

  if (actions.length === 0) {
    console.log("No PubChat-managed changes needed.");
    return;
  }

  for (const action of actions) {
    printAction(action);
  }

  if (!apply) return;

  let latest = current;

  for (const action of actions) {
    if (action.kind === "create") {
      latest = await api(`/zones/${zoneId}/rulesets/${latest.id}/rules`, {
        method: "POST",
        body: action.rule,
      });
      continue;
    }

    if (action.kind === "patch") {
      latest = await api(
        `/zones/${zoneId}/rulesets/${latest.id}/rules/${action.existing.id}`,
        {
          method: "PATCH",
          body: action.rule,
        },
      );
      continue;
    }

    if (action.kind === "delete") {
      latest = await api(
        `/zones/${zoneId}/rulesets/${latest.id}/rules/${action.existing.id}`,
        { method: "DELETE" },
      );
    }
  }

  console.log(`Applied ${actions.length} change(s). Ruleset version is now ${latest.version}.`);
}

async function getEntrypoint(zoneId, phase) {
  const response = await api(
    `/zones/${zoneId}/rulesets/phases/${encodeURIComponent(phase)}/entrypoint`,
    { allowNotFound: true },
  );

  return response.notFound ? null : response;
}

async function lookupZoneId(name) {
  validateHost(name);

  const zones = await api(`/zones?name=${encodeURIComponent(name)}`);
  if (!Array.isArray(zones) || zones.length === 0) {
    throw new Error(`Could not find Cloudflare zone named ${name}. Set CLOUDFLARE_ZONE_ID instead.`);
  }

  return zones[0].id;
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const payload = text ? parseJson(text) : {};

  if (options.allowNotFound && response.status === 404) {
    return { notFound: true };
  }

  if (!response.ok || payload.success === false) {
    const errors = Array.isArray(payload.errors)
      ? payload.errors.map(error => error.message ?? JSON.stringify(error)).join("; ")
      : text;
    throw new Error(`Cloudflare API ${response.status}: ${errors || response.statusText}`);
  }

  return payload.result ?? payload;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Cloudflare API returned non-JSON response: ${text.slice(0, 200)}`);
  }
}

function isManagedRule(rule) {
  return typeof rule.ref === "string" && rule.ref.startsWith(MANAGED_REF_PREFIX);
}

function rulesEquivalent(existing, desired) {
  return JSON.stringify(normalizeRule(existing)) === JSON.stringify(normalizeRule(desired));
}

function normalizeRule(rule) {
  return {
    ref: rule.ref,
    description: rule.description,
    expression: rule.expression,
    action: rule.action,
    enabled: rule.enabled !== false,
    ratelimit: rule.ratelimit ? {
      characteristics: rule.ratelimit.characteristics,
      period: rule.ratelimit.period,
      requests_per_period: rule.ratelimit.requests_per_period,
      mitigation_timeout: rule.ratelimit.mitigation_timeout,
      requests_to_origin: rule.ratelimit.requests_to_origin,
    } : undefined,
  };
}

function printExistingRules(ruleset) {
  if (!ruleset) {
    console.log("No entry point ruleset exists.");
    return;
  }

  console.log(`Ruleset ${ruleset.id}, version ${ruleset.version}`);
  for (const rule of ruleset.rules ?? []) {
    console.log(`- ${rule.enabled === false ? "disabled" : "enabled"} ${rule.ref ?? rule.id}: ${rule.description ?? rule.action}`);
  }
}

function printDesiredRules(rules) {
  for (const rule of rules) {
    console.log(`- ${rule.ref}: ${rule.description}`);
  }
}

function printAction(action) {
  if (action.kind === "create") {
    console.log(`Would create ${action.rule.ref}: ${action.rule.description}`);
    return;
  }

  if (action.kind === "patch") {
    console.log(`Would update ${action.rule.ref}: ${action.rule.description}`);
    return;
  }

  console.log(`Would delete stale ${action.existing.ref}: ${action.existing.description}`);
}

function hostExpression(value) {
  return `http.host eq ${JSON.stringify(value)}`;
}

function pathContains(value) {
  return `http.request.uri.path contains ${JSON.stringify(value)}`;
}

function and(parts) {
  return `(${parts.join(" and ")})`;
}

function or(parts) {
  return `(${parts.join(" or ")})`;
}

function validateHost(value) {
  if (!/^[a-z0-9.-]+$/i.test(value)) {
    throw new Error(`Invalid host value: ${value}`);
  }
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function printHelp() {
  console.log(`
Usage:
  node scripts/cf-apply-security-rules.mjs [--apply|--list]

Environment:
  CLOUDFLARE_API_TOKEN      Required API token.
  CLOUDFLARE_ZONE_ID        Zone ID. Optional if CLOUDFLARE_ZONE_NAME is set.
  CLOUDFLARE_ZONE_NAME      Zone name, defaults to pubchat.org.
  PUBCHAT_HOST              Host to match in rules, defaults to the zone name.
  PUBCHAT_RATE_LIMIT_PERIOD Seconds per rate window, defaults to 10.
  PUBCHAT_RATE_LIMIT_REQUESTS Requests per window, defaults to 40.
  PUBCHAT_RATE_LIMIT_MITIGATION Mitigation seconds, defaults to 10.

The script manages only rules whose ref starts with "pubchat-".
`);
}
