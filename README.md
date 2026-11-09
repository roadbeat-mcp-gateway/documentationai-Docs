# roadbeat MCP Gateway — Documentation

This repository contains the published end-user documentation for the roadbeat MCP Gateway, powered by
[documentation.ai](https://documentation.ai). Pushing to `main` deploys the site.

## Structure

```
mcp-gateway-docs/
├── documentation.json              # Navigation, tabs and branding
├── introduction.mdx · quickstart.mdx · concepts.mdx
├── connect/                        # Claude, Claude Code, ChatGPT, Cursor, Desktop extension, Inspector
├── accounts/                       # Sign-in, scopes, consent & confirmations, rate limits & retries
├── tools/                          # Catalog overview and one page per server, prompts & skills, why-card
├── security/                       # Privacy & your data, security model
├── self-hosting/                   # Overview, Docker, configuration, authorization servers, operations
├── api-reference/
│   ├── overview.mdx · authentication.mdx · mcp-endpoints.mdx
│   └── openapi.json                # Admin & Integration Hub API (OpenAPI 3.0)
├── help-center.mdx
├── help-center/{faq,troubleshooting,guides}/
├── changelog.mdx
└── scripts/enrich-openapi.mjs      # Builds api-reference/openapi.json from the gateway's Swagger output
```

## Editing

Pages are MDX with documentation.ai components (Callout, Card, Columns, Steps, Tabs, CodeGroup, Expandable,
ParamField, ResponseField, Update, Mermaid). Follow the `documentation-ai` skill in the workspace
(`.claude/skills/documentation-ai/SKILL.md`): every page needs `title` + `description`, every page must be listed in
`documentation.json`, internal links are absolute (`/tools/discovery`).

Sources of truth for the content: `docs/mcp-gateway/MCP_GATEWAY.md` (tracker and build notes),
`docs/mcp-gateway/AUTHORIZATION_SERVER.md`, and the gateway code (`mcp-gateway/apps/api/src`).

## Regenerating the API reference

`api-reference/openapi.json` is generated from the gateway itself, then enriched with schemas and descriptions
(the gateway's controllers do not carry `@ApiProperty` / response decorators yet):

```bash
# 1. Build and start a gateway on a free port without a database
cd ../mcp-gateway && pnpm --filter @roadbeat/mcp-gateway-api build
cd apps/api && GATEWAY_STORE=memory PORT=3790 PUBLIC_BASE_URL=http://localhost:3790 NODE_ENV=development node dist/main

# 2. In a second shell: fetch the Swagger document, stop the gateway, enrich
curl -s http://localhost:3790/api/docs-json > /tmp/gateway-swagger.json
node scripts/enrich-openapi.mjs /tmp/gateway-swagger.json api-reference/openapi.json
```

The script fails when the gateway has an endpoint (or parameter) it does not describe yet, or describes one that no
longer exists — update the overlay in `scripts/enrich-openapi.mjs` in that case.

## Related repositories

| Repository | Description |
|------------|-------------|
| [mcp-gateway](https://git.roadbeat.net:3000/roadbeat/mcp-gateway) | Gateway source code |

## License

Copyright © roadbeat e.V. All rights reserved.
