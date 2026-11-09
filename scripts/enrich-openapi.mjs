#!/usr/bin/env node
/**
 * Builds api-reference/openapi.json from the Swagger document the MCP Gateway generates itself.
 *
 *   1. Start a gateway build (see README.md → "Regenerating the API reference") and save
 *      GET <gateway>/api/docs-json to a file.
 *   2. node scripts/enrich-openapi.mjs <generated.json> [api-reference/openapi.json]
 *
 * The generated document has every path, method, tag and security requirement, but v0.1.0 of the gateway carries no
 * `@ApiProperty` / `@ApiQuery` / response decorators: request bodies are empty objects, optional query parameters are
 * marked required and responses have no schema. This script overlays descriptions and schemas taken from the gateway
 * source (admin.controller.ts, stores.ts, health.controller.ts). It refuses to run when the overlay names an
 * operation or parameter the generated document does not have — so a changed API is noticed, not papered over.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [input, output = join(here, '..', 'api-reference', 'openapi.json')] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/enrich-openapi.mjs <generated-swagger.json> [output.json]');
  process.exit(2);
}
const doc = JSON.parse(readFileSync(resolve(input), 'utf8'));

// ── shared pieces ────────────────────────────────────────────────────────────
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const dateTime = { type: 'string', format: 'date-time' };
// OpenAPI 3.0 ignores siblings of $ref, so a nullable reference is wrapped in allOf.
const nullable = (s) => (s.$ref ? { allOf: [s], nullable: true } : { ...s, nullable: true });
const CONSENT_CLASSES = ['read_public', 'read_personal', 'write_personal', 'read_org', 'write_org', 'network_call', 'pii_egress'];
const LIFETIMES = ['once', 'day', 'days30', 'permanent'];
const ADMIN_ERRORS = {
  401: { $ref: '#/components/responses/Unauthorized' },
  403: { $ref: '#/components/responses/Forbidden' },
};
const limit = (def, max = 500) => ({
  required: false,
  description: `Maximum number of entries (1–${max}, default ${def}).`,
  schema: { type: 'integer', minimum: 1, maximum: max, default: def },
});
const optional = (description, schema = { type: 'string' }) => ({ required: false, description, schema });

const schemas = {
  ConsentClass: {
    type: 'string',
    enum: CONSENT_CLASSES,
    description:
      'What a tool does with data. read_public and read_org need no consent; the other classes need a consent per (principal, OAuth client).',
  },
  ConsentLifetime: {
    type: 'string',
    enum: LIFETIMES,
    description: 'once = for one successful call · day = 24 hours · days30 = 30 days · permanent = until revoked.',
  },
  GrantConsentDto: {
    type: 'object',
    additionalProperties: false,
    required: ['principalId', 'clientId', 'consentClass', 'lifetime'],
    properties: {
      principalId: { type: 'string', description: 'Gateway principal id: `<issuer name>:<subject>`, e.g. `web-client:7f3c…`.', example: 'web-client:6c1d8e2a-4b7f-4f0e-9a51-2d1f0c9e7a10' },
      clientId: { type: 'string', description: 'OAuth client id (a Client ID Metadata Document URL or a pre-registered id).', example: 'https://ai-app.example/oauth/client-metadata.json' },
      consentClass: ref('ConsentClass'),
      lifetime: ref('ConsentLifetime'),
    },
  },
  RevokeAllDto: {
    type: 'object',
    additionalProperties: false,
    required: ['principalId'],
    properties: {
      principalId: { type: 'string', description: 'Principal whose consents are revoked.' },
      clientId: { type: 'string', description: 'Only revoke the consents given to this OAuth client.' },
    },
  },
  CapabilityDto: {
    type: 'object',
    additionalProperties: false,
    required: ['enabled'],
    properties: { enabled: { type: 'boolean', description: '`false` hides the entry from every catalog view of this deployment.' } },
  },
  EraseDto: {
    type: 'object',
    additionalProperties: false,
    required: ['confirm'],
    properties: {
      confirm: { type: 'string', description: 'Must repeat the principal id from the path — a guard against erasing the wrong account.' },
    },
  },
  ErasureResult: {
    type: 'object',
    required: ['erased', 'pseudonym', 'counts'],
    properties: {
      erased: { type: 'boolean', enum: [true] },
      pseudonym: { type: 'string', description: 'Random pseudonym the audit records were re-keyed to (`erased:<uuid>`); not derivable from the principal id.', example: 'erased:2f0c5b8e-7a4d-4c1e-9b61-0d3c2a9e8f17' },
      counts: {
        type: 'object',
        properties: {
          consents: { type: 'integer', description: 'Consents deleted' },
          confirmations: { type: 'integer', description: 'Approval requests deleted' },
          idempotency: { type: 'integer', description: 'Stored write results deleted' },
          tasks: { type: 'integer', description: 'Task handles deleted' },
          audit: { type: 'integer', description: 'Audit records pseudonymized (incl. admin records naming the principal)' },
        },
      },
    },
  },
  PrincipalExport: {
    type: 'object',
    description: 'Everything the gateway stores about one principal, as one JSON document (sent as an attachment).',
    required: ['export', 'consents', 'confirmations', 'idempotency', 'audit'],
    properties: {
      export: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['roadbeat-mcp-gateway-principal-export'] },
          formatVersion: { type: 'integer', enum: [1] },
          generatedAt: dateTime,
          principalId: { type: 'string' },
          counts: {
            type: 'object',
            properties: { consents: { type: 'integer' }, confirmations: { type: 'integer' }, idempotency: { type: 'integer' }, audit: { type: 'integer' } },
          },
          truncated: { type: 'boolean', description: 'true when the audit history exceeded 50,000 records; the newest are included.' },
          notes: { type: 'array', items: { type: 'string' } },
        },
      },
      consents: { type: 'array', items: ref('ConsentRecord'), description: 'Including revoked and expired consents.' },
      confirmations: { type: 'array', items: ref('ConfirmationRecord') },
      idempotency: {
        type: 'array',
        description: 'Stored write results — metadata only, without the results themselves.',
        items: {
          type: 'object',
          properties: { tool: { type: 'string' }, idempotencyKey: { type: 'string' }, createdAt: dateTime, expiresAt: dateTime },
        },
      },
      audit: { type: 'array', items: ref('AuditRecord') },
    },
  },
  AdminUiConfig: {
    type: 'object',
    description: 'Where the admin UI signs in. Public: it only names the authorization server and the UI\'s public client id.',
    required: ['configured', 'resource', 'scope', 'gatewayVersion'],
    properties: {
      configured: { type: 'boolean', description: 'false when no authorization server for the admin UI is configured (the UI explains how to fix it).' },
      issuer: { type: 'string', example: 'https://studio.example.com' },
      issuerName: { type: 'string', example: 'studio' },
      clientId: { type: 'string', description: 'The admin UI\'s public OAuth client id.', example: 'https://mcp.example.com/admin/oauth-client.json' },
      resource: { type: 'string', description: 'RFC 8707 resource the admin token is requested for.', example: 'https://mcp.example.com/mcp' },
      scope: { type: 'string', enum: ['mcp:admin'] },
      authorizationEndpoint: { type: 'string', format: 'uri' },
      tokenEndpoint: { type: 'string', format: 'uri' },
      revocationEndpoint: { type: 'string', format: 'uri' },
      gatewayVersion: { type: 'string', example: '0.1.0' },
    },
  },
  ConsentRecord: {
    type: 'object',
    required: ['id', 'principalId', 'clientId', 'consentClass', 'scopes', 'lifetime', 'grantedAt', 'expiresAt', 'revokedAt', 'usesLeft'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      principalId: { type: 'string' },
      clientId: { type: 'string' },
      consentClass: ref('ConsentClass'),
      scopes: { type: 'array', items: { type: 'string' } },
      lifetime: ref('ConsentLifetime'),
      grantedAt: dateTime,
      expiresAt: nullable({ ...dateTime, description: 'null for `once` and `permanent` consents.' }),
      revokedAt: nullable(dateTime),
      usesLeft: nullable({ type: 'integer', description: 'Remaining uses of a `once` consent; null otherwise.' }),
    },
  },
  ConfirmationRecord: {
    type: 'object',
    description: 'A first-time consent request or a confirmation of a destructive call, decided on the approval page.',
    required: ['id', 'kind', 'principalId', 'clientId', 'tool', 'argsHash', 'consentClass', 'summary', 'mode', 'status', 'createdAt', 'decidedAt', 'consumedAt', 'expiresAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['consent', 'confirmation'] },
      principalId: { type: 'string' },
      clientId: { type: 'string' },
      tool: { type: 'string', description: 'Tool name, or `resource:<name>` for a resource read.' },
      argsHash: { type: 'string', description: 'SHA-256 of the call arguments (`consent:<class>` for consent requests). Arguments themselves are never stored.' },
      consentClass: nullable(ref('ConsentClass')),
      summary: { type: 'string', description: 'The human-readable text shown on the approval page.' },
      mode: { type: 'string', enum: ['elicit', 'out_of_band'] },
      status: { type: 'string', enum: ['pending', 'approved', 'denied', 'expired', 'consumed'] },
      createdAt: dateTime,
      decidedAt: nullable(dateTime),
      consumedAt: nullable(dateTime),
      expiresAt: dateTime,
    },
  },
  ClientRecord: {
    type: 'object',
    description: 'An OAuth client the gateway has seen (read-through mirror; the client registry itself lives at the authorization server).',
    required: ['issuer', 'clientId', 'name', 'version', 'registration', 'trusted', 'firstSeenAt', 'lastSeenAt'],
    properties: {
      issuer: { type: 'string', description: 'Authorization server that issued the client\'s tokens (`local` for the stdio sidecar).' },
      clientId: { type: 'string' },
      name: nullable({ type: 'string', description: 'Self-asserted client name (display only).' }),
      version: nullable({ type: 'string' }),
      registration: nullable({ type: 'string', description: '`cimd` (client id is an HTTPS URL), `local`, or `unknown`.' }),
      trusted: { type: 'boolean' },
      firstSeenAt: dateTime,
      lastSeenAt: dateTime,
    },
  },
  AuditRecord: {
    type: 'object',
    required: ['id', 'ts', 'principalId', 'principalType', 'clientId', 'transport', 'kind', 'name', 'result', 'payload'],
    properties: {
      id: { type: 'string', description: 'Monotonic id; also the pagination cursor.' },
      ts: dateTime,
      principalId: { type: 'string' },
      principalType: { type: 'string', enum: ['user', 'service', 'anonymous', 'local'] },
      clientId: { type: 'string' },
      requestId: { type: 'string', description: 'JSON-RPC request id.' },
      traceId: { type: 'string', description: 'W3C trace id when the client sent `traceparent`.' },
      protocolVersion: { type: 'string', example: '2026-07-28' },
      transport: { type: 'string', enum: ['streamable-http', 'stdio', 'approval-page', 'admin-api'] },
      kind: { type: 'string', enum: ['tool_call', 'resource_read', 'prompt_get', 'consent', 'confirmation', 'admin'] },
      name: { type: 'string', description: 'Tool, resource URI, prompt or admin action name.' },
      result: { type: 'string', enum: ['ok', 'error', 'denied', 'rate_limited', 'input_required', 'replayed'] },
      durationMs: { type: 'integer' },
      payload: {
        type: 'object',
        additionalProperties: true,
        description: 'Hashes and identifiers only (argsHash, destructive, resourceUris, idempotencyKey, confirmation mode, denial reason …) — never tokens or raw personal content.',
      },
    },
  },
  AuditPage: {
    type: 'object',
    required: ['items'],
    properties: {
      items: { type: 'array', items: ref('AuditRecord') },
      nextCursor: { type: 'string', description: 'Pass as `cursor` to get the next (older) page. Absent on the last page.' },
    },
  },
  ToolAnnotations: {
    type: 'object',
    properties: {
      readOnlyHint: { type: 'boolean' },
      destructiveHint: { type: 'boolean' },
      idempotentHint: { type: 'boolean' },
      openWorldHint: { type: 'boolean' },
    },
  },
  CatalogTool: {
    type: 'object',
    required: ['name', 'title', 'server', 'core', 'scopes', 'consentClass', 'confirmation', 'annotations', 'enabled'],
    properties: {
      name: { type: 'string', example: 'discovery_search' },
      title: { type: 'string' },
      server: { type: 'string', enum: ['gateway', 'studio', 'discovery', 'cd', 'schema', 'pod', 'augmentor', 'goals', 'web'] },
      core: { type: 'boolean', description: 'Part of the core catalog served at `/mcp`.' },
      scopes: { type: 'array', items: { type: 'string' } },
      consentClass: ref('ConsentClass'),
      confirmation: { type: 'string', enum: ['none', 'elicit', 'out_of_band'] },
      annotations: ref('ToolAnnotations'),
      enabled: { type: 'boolean' },
    },
  },
  CatalogResource: {
    type: 'object',
    required: ['name', 'uri', 'server', 'core', 'scopes', 'consentClass', 'enabled'],
    properties: {
      name: { type: 'string' },
      uri: { type: 'string', description: 'Fixed URI or RFC 6570 URI template.', example: 'schema://types/{typeId}' },
      server: { type: 'string' },
      core: { type: 'boolean' },
      scopes: { type: 'array', items: { type: 'string' } },
      consentClass: ref('ConsentClass'),
      enabled: { type: 'boolean' },
    },
  },
  CatalogPrompt: {
    type: 'object',
    required: ['name', 'server', 'core', 'scopes', 'enabled'],
    properties: {
      name: { type: 'string' },
      server: { type: 'string' },
      core: { type: 'boolean' },
      scopes: { type: 'array', items: { type: 'string' } },
      enabled: { type: 'boolean' },
    },
  },
  Catalog: {
    type: 'object',
    required: ['tools', 'resources', 'prompts'],
    properties: {
      tools: { type: 'array', items: ref('CatalogTool') },
      resources: { type: 'array', items: ref('CatalogResource') },
      prompts: { type: 'array', items: ref('CatalogPrompt') },
    },
  },
  Health: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      service: { type: 'string', example: 'mcp-gateway' },
      version: { type: 'string', example: '0.1.0' },
      store: { type: 'string', enum: ['prisma', 'memory'] },
      catalog: {
        type: 'object',
        properties: { tools: { type: 'integer', example: 55 }, resources: { type: 'integer', example: 33 }, prompts: { type: 'integer', example: 4 } },
      },
      upstreams: {
        type: 'object',
        properties: {
          discoveryNodes: { type: 'integer', description: 'Number of configured Discovery Nodes.' },
          schemaRegistry: { type: 'string', format: 'uri' },
          contextDirectory: { type: 'string', format: 'uri' },
        },
      },
    },
  },
  Readiness: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ready', 'not_ready'] },
      reason: { type: 'string', description: 'Why the store is not reachable (only when not ready).' },
    },
  },
  Error: {
    type: 'object',
    description: 'NestJS error body.',
    properties: {
      statusCode: { type: 'integer', example: 403 },
      message: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], example: 'mcp:admin scope required' },
      error: { type: 'string', example: 'Forbidden' },
    },
  },
};

// ── per-operation overlay ────────────────────────────────────────────────────
const ops = {
  'get /api/v1/health': {
    summary: 'Liveness and configuration summary',
    description: 'Public. Returns the version, the store in use, the size of the catalog and the configured upstreams. Used by the Docker health check.',
    responses: { 200: json(ref('Health')) },
  },
  'get /api/v1/health/ready': {
    summary: 'Readiness',
    description: 'Public. `200` when the store (PostgreSQL) answers, `503` otherwise — use it as the readiness probe of your orchestrator.',
    responses: { 200: json(ref('Readiness'), 'Ready'), 503: json(ref('Readiness'), 'Store not reachable') },
  },
  'get /api/v1/admin/clients': {
    summary: 'List OAuth clients seen by the gateway',
    description:
      'The OAuth clients (AI apps) that have called this gateway, newest activity first. This is a mirror for display and audit; clients are registered and removed at the authorization server (Studio / Web Client), not here.',
    parameters: { limit: limit(100) },
    responses: { 200: json({ type: 'array', items: ref('ClientRecord') }), ...ADMIN_ERRORS },
  },
  'get /api/v1/admin/activity': {
    summary: 'Recent activity',
    description: 'The latest audit entries across all principals and clients (shortcut for an unfiltered `GET /api/v1/admin/audit`).',
    parameters: { limit: limit(50) },
    responses: { 200: json(ref('AuditPage')), ...ADMIN_ERRORS },
  },
  'get /api/v1/admin/audit': {
    summary: 'Query the audit log',
    description: 'Paginated, newest first. Combine the filters freely; follow `nextCursor` for older entries.',
    parameters: {
      principalId: optional('Only entries of this principal (`<issuer name>:<subject>`).'),
      clientId: optional('Only entries of this OAuth client.'),
      kind: optional('Entry kind.', { type: 'string', enum: ['tool_call', 'resource_read', 'prompt_get', 'consent', 'confirmation', 'admin'] }),
      name: optional('Exact tool / resource / prompt / admin action name.'),
      since: optional('Only entries at or after this time (ISO 8601).', { type: 'string', format: 'date-time' }),
      until: optional('Only entries at or before this time (ISO 8601).', { type: 'string', format: 'date-time' }),
      cursor: optional('`nextCursor` of the previous page.'),
      limit: limit(50),
    },
    responses: { 200: json(ref('AuditPage')), ...ADMIN_ERRORS },
  },
  'get /api/v1/admin/consents': {
    summary: 'List consents',
    description: 'The consent ledger. Without `all=true` only active consents (not revoked, not expired, uses left) are returned. At most 200 entries.',
    parameters: {
      principalId: optional('Only consents of this principal.'),
      clientId: optional('Only consents given to this OAuth client.'),
      all: optional('`true` also returns revoked and expired consents.', { type: 'string', enum: ['true', 'false'] }),
    },
    responses: { 200: json({ type: 'array', items: ref('ConsentRecord') }), ...ADMIN_ERRORS },
  },
  'post /api/v1/admin/consents': {
    summary: 'Grant a consent',
    description: 'Grants a consent on behalf of a principal for one OAuth client and consent class. The action is written to the audit log before the response is sent.',
    responses: { 201: json(ref('ConsentRecord'), 'Created'), 400: json(ref('Error'), 'Invalid body'), ...ADMIN_ERRORS },
  },
  'delete /api/v1/admin/consents/{id}': {
    summary: 'Revoke a consent',
    parameters: { id: { description: 'Consent id.', schema: { type: 'string', format: 'uuid' } } },
    responses: {
      200: json({ type: 'object', properties: { revoked: { type: 'boolean', enum: [true] } } }),
      404: json(ref('Error'), 'Consent not found or already revoked'),
      ...ADMIN_ERRORS,
    },
  },
  'post /api/v1/admin/consents/revoke-all': {
    summary: 'Revoke all consents of a principal',
    description: 'Revokes every active consent of a principal — for all OAuth clients, or only for `clientId`. Use it when a user asks to cut off all AI apps at once.',
    responses: {
      201: json({ type: 'object', properties: { revoked: { type: 'integer', description: 'Number of consents revoked.' } } }, 'Done'),
      400: json(ref('Error'), 'Invalid body'),
      ...ADMIN_ERRORS,
    },
  },
  'get /api/v1/admin/principals/{principalId}/export': {
    summary: 'Export a principal\'s data (GDPR)',
    description:
      'Everything the gateway stores about one principal in one JSON document: consents (including revoked ones), approval requests, ' +
      'stored write results (metadata only) and the audit log. Sent as an attachment with `Cache-Control: no-store`; the export itself is audited.',
    parameters: { principalId: { description: 'Principal id as shown in the audit log, e.g. `web-client:6c1d8e2a-…`.', schema: { type: 'string' } } },
    responses: { 200: json(ref('PrincipalExport')), ...ADMIN_ERRORS },
  },
  'post /api/v1/admin/principals/{principalId}/erase': {
    summary: 'Erase a principal (GDPR)',
    description:
      'Deletes the principal\'s consents, approval requests, stored write results and tasks. Audit records are kept for accountability ' +
      'but re-keyed to a random pseudonym (`erased:<uuid>`) with personal payload fields removed; admin records that name the principal ' +
      'are re-keyed too. The erasure is audited under the pseudonym only. Cannot be undone — call it when the account was deleted at its authorization server.',
    parameters: { principalId: { description: 'Principal to erase.', schema: { type: 'string' } } },
    responses: {
      201: json(ref('ErasureResult'), 'Erased'),
      400: json(ref('Error'), '`confirm` does not repeat the principal id, or you tried to erase your own principal'),
      ...ADMIN_ERRORS,
    },
  },
  'get /api/v1/admin-ui/config': {
    summary: 'Admin UI sign-in configuration',
    description:
      'Public. Tells the admin UI at `/admin` where to sign in: the authorization server (resolved from its metadata by the gateway), ' +
      'the UI\'s public client id, the resource and the `mcp:admin` scope. `configured: false` when no suitable issuer is set.',
    responses: {
      200: json(ref('AdminUiConfig')),
      503: json(ref('Error'), 'The authorization server is not reachable'),
    },
  },
  'get /api/v1/admin/confirmations': {
    summary: 'List approvals',
    description: 'Consent requests and destructive-call confirmations, pending and decided, newest first.',
    parameters: {
      principalId: optional('Only approvals of this principal.'),
      status: optional('Only approvals in this state.', { type: 'string', enum: ['pending', 'approved', 'denied', 'expired', 'consumed'] }),
      limit: limit(50),
    },
    responses: { 200: json({ type: 'array', items: ref('ConfirmationRecord') }), 400: json(ref('Error'), 'Invalid status'), ...ADMIN_ERRORS },
  },
  'get /api/v1/admin/catalog': {
    summary: 'Full catalog',
    description: 'Every tool, resource and prompt the gateway ships, including entries disabled for this deployment, with scopes, consent class, confirmation mode and annotations. Typed `studio_create_<type>` tools are generated per organization and are not listed.',
    responses: { 200: json(ref('Catalog')), ...ADMIN_ERRORS },
  },
  'put /api/v1/admin/catalog/{kind}/{name}': {
    summary: 'Enable or disable a catalog entry',
    description: 'Turns a tool, resource or prompt off (or back on) for this deployment. Instances pick up the change within a minute.',
    parameters: {
      kind: { description: 'Entry kind.', schema: { type: 'string', enum: ['tool', 'resource', 'prompt'] } },
      name: { description: 'Entry name as listed in the catalog, e.g. `studio_publish_content`.', schema: { type: 'string' } },
    },
    responses: {
      200: json({
        type: 'object',
        properties: { kind: { type: 'string', enum: ['tool', 'resource', 'prompt'] }, name: { type: 'string' }, enabled: { type: 'boolean' } },
      }),
      400: json(ref('Error'), 'Invalid kind or body'),
      404: json(ref('Error'), 'No such entry'),
      ...ADMIN_ERRORS,
    },
  },
  'get /api/v1/catalog': {
    summary: 'Catalog for the Integration Hub',
    description: 'The catalog as the Studio Integration Hub reads it: only enabled tools (resources and prompts are listed with their `enabled` flag).',
    responses: { 200: json(ref('Catalog')), ...ADMIN_ERRORS },
  },
  'get /api/v1/consents': {
    summary: 'Consents for the Integration Hub',
    description: 'Active consents, optionally filtered by principal and OAuth client (at most 200).',
    parameters: {
      principalId: optional('Only consents of this principal.'),
      clientId: optional('Only consents given to this OAuth client.'),
    },
    responses: { 200: json({ type: 'array', items: ref('ConsentRecord') }), ...ADMIN_ERRORS },
  },
  'post /api/v1/consents': {
    summary: 'Record a consent decision from the Integration Hub',
    description: 'Records a consent the user granted in the Integration Hub UI, so the gateway and the Hub share one ledger.',
    responses: { 201: json(ref('ConsentRecord'), 'Created'), 400: json(ref('Error'), 'Invalid body'), ...ADMIN_ERRORS },
  },
};

// ── apply ────────────────────────────────────────────────────────────────────
const problems = [];
const seen = new Set();
for (const [key, overlay] of Object.entries(ops)) {
  const [method, path] = key.split(' ');
  const op = doc.paths?.[path]?.[method];
  if (!op) {
    problems.push(`overlay names ${method.toUpperCase()} ${path}, which the generated document does not have`);
    continue;
  }
  seen.add(key);
  if (overlay.summary) op.summary = overlay.summary;
  if (overlay.description) op.description = overlay.description;
  for (const [name, patch] of Object.entries(overlay.parameters ?? {})) {
    const p = (op.parameters ?? []).find((x) => x.name === name);
    if (!p) {
      problems.push(`${method.toUpperCase()} ${path}: no parameter "${name}" in the generated document`);
      continue;
    }
    Object.assign(p, patch);
  }
  if (overlay.responses) op.responses = overlay.responses;
}
for (const [path, item] of Object.entries(doc.paths ?? {})) {
  for (const method of Object.keys(item)) {
    if (!seen.has(`${method} ${path}`)) problems.push(`generated ${method.toUpperCase()} ${path} has no overlay — document it in scripts/enrich-openapi.mjs`);
  }
}
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}

doc.info = {
  ...doc.info,
  title: 'roadbeat MCP Gateway — Admin & Integration API',
  description:
    'REST endpoints of the roadbeat MCP Gateway for administrators and the Studio Integration Hub: OAuth clients seen, ' +
    'activity and audit log, consent ledger, approvals, per-deployment catalog switches and GDPR export / erasure per principal, ' +
    'plus the admin UI bootstrap configuration and health probes.\n\n' +
    'Every admin and Integration Hub endpoint needs a gateway access token (audience = the gateway\'s `/mcp` resource) ' +
    'with the `mcp:admin` scope. The MCP endpoints themselves (`/mcp`, `/mcp/all`, `/mcp/{server}`) speak the Model ' +
    'Context Protocol, not REST — see "MCP endpoints" in this reference.',
  license: { name: 'AGPL-3.0', url: 'https://www.gnu.org/licenses/agpl-3.0.html' },
  contact: { name: 'roadbeat e.V.', url: 'https://roadbeat.net' },
};
doc.servers = [
  { url: 'https://{gateway}', description: 'Your gateway', variables: { gateway: { default: 'mcp.example.com', description: 'Host of your MCP Gateway' } } },
  { url: 'http://localhost:3700', description: 'Local development' },
];
doc.tags = [
  { name: 'admin', description: 'Gateway administration (`mcp:admin`).' },
  { name: 'integration-hub', description: 'Catalog and consent API used by the Studio Integration Hub (`mcp:admin`).' },
  { name: 'admin-ui', description: 'Public bootstrap configuration of the admin UI at `/admin`.' },
  { name: 'health', description: 'Public liveness and readiness probes.' },
];
doc.components = {
  ...doc.components,
  securitySchemes: {
    bearer: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'RFC 9068 access token (`typ: at+jwt`, asymmetrically signed) from a trusted authorization server, audience = `https://<gateway>/mcp`, scope `mcp:admin`.',
    },
  },
  responses: {
    Unauthorized: json(ref('Error'), 'Missing, expired or untrusted token, or wrong audience'),
    Forbidden: json(ref('Error'), 'Token lacks the `mcp:admin` scope'),
  },
  schemas: { ...(doc.components?.schemas ?? {}), ...schemas },
};

writeFileSync(resolve(output), JSON.stringify(doc, null, 2) + '\n');
console.log(`✓ ${resolve(output)} (${Object.keys(doc.paths).length} paths)`);
