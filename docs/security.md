# PubChat Security Setup

This repo has two layers of command-line security setup:

1. Response headers, versioned in `src/index.ts` for Worker-generated responses
   and `public/_headers` for static assets served by Workers Assets.
2. Cloudflare edge rules, managed with `scripts/cf-apply-security-rules.mjs`.

## Worker Headers

Deploy the response headers with:

```sh
npm run deploy
```

After deployment, verify the public response headers with:

```sh
npm run headers:check
```

The header check verifies the live `https://pubchat.org` response:

- `Content-Security-Policy`
- `Cross-Origin-Opener-Policy`
- `Permissions-Policy`
- `Referrer-Policy`
- `X-Content-Type-Options`
- `X-Frame-Options`

## Cloudflare API Token

Create a Cloudflare API token with access to the `pubchat.org` zone.

The script needs read access to find the zone by name and write access to
create or update ruleset rules. Cloudflare's Rulesets API docs list `Zone WAF
Write` as a sufficient permission for zone WAF custom/rate limiting rules, and
`Zone Read` is useful when using `CLOUDFLARE_ZONE_NAME` instead of a fixed zone
ID.

Set the token and either the zone ID or zone name:

```sh
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ZONE_NAME="pubchat.org"
```

If you already know the zone ID, this avoids an API lookup:

```sh
export CLOUDFLARE_ZONE_ID="..."
```

## Edge Rules

Preview the Cloudflare changes:

```sh
npm run cf:security:plan
```

Apply them:

```sh
npm run cf:security:apply
```

List the current entry point rulesets and rules:

```sh
npm run cf:security:list
```

The script manages only rules whose `ref` starts with `pubchat-`.
It leaves unrelated Cloudflare rules alone.

Configured rules:

- `pubchat-block-obvious-probes`: blocks obvious non-app probes such as
  WordPress, PHPMyAdmin, `.env`, `.git`, and actuator scans.
- `pubchat-rate-limit-dynamic-routes`: blocks clients that exceed the dynamic
  route threshold for `/chat`, `/at`, and `/open`.

The default dynamic-route rate limit is `40` requests per `10` seconds per
IP/colo, with a `10` second mitigation timeout. Cloudflare returned `10`
seconds as the allowed period and mitigation timeout for the current
account/plan. Tune it with:

```sh
setenv PUBCHAT_RATE_LIMIT_REQUESTS 40
setenv PUBCHAT_RATE_LIMIT_PERIOD 10
setenv PUBCHAT_RATE_LIMIT_MITIGATION 10
npm run cf:security:plan
```

Then apply after reviewing the plan.

## References

- Cloudflare custom rules API:
  https://developers.cloudflare.com/waf/custom-rules/create-api/
- Cloudflare rate limiting rules API:
  https://developers.cloudflare.com/waf/rate-limiting-rules/create-api/
- Cloudflare Rulesets API:
  https://developers.cloudflare.com/ruleset-engine/rulesets-api/
