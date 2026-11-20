import { z } from 'zod';

/**
 * REQVYN domain model. Every persisted entity carries a stable `id`. Hierarchy is expressed with
 * `parentId` + `sortKey` (a flat list), which makes moves/reorders and request-level merges during
 * synchronization trivial and conflict-friendly.
 */

export const SCHEMA_VERSION = 1;

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type StandardMethod = (typeof HTTP_METHODS)[number];

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

export const KeyValueSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string().default(''),
  enabled: z.boolean().default(true),
  description: z.string().optional(),
  /** Marks a variable as secret: its value is kept in secret storage and never written to collection files. */
  secret: z.boolean().optional(),
});
export type KeyValue = z.infer<typeof KeyValueSchema>;

export const MultipartPartSchema = z.object({
  id: z.string(),
  key: z.string(),
  enabled: z.boolean().default(true),
  type: z.enum(['text', 'file']),
  value: z.string().default(''),
  filePath: z.string().optional(),
  contentType: z.string().optional(),
});
export type MultipartPart = z.infer<typeof MultipartPartSchema>;

export const BodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('json'), text: z.string() }),
  z.object({ mode: z.literal('xml'), text: z.string() }),
  z.object({ mode: z.literal('text'), text: z.string(), contentType: z.string().optional() }),
  z.object({ mode: z.literal('urlencoded'), fields: z.array(KeyValueSchema) }),
  z.object({ mode: z.literal('multipart'), parts: z.array(MultipartPartSchema) }),
  z.object({ mode: z.literal('binary'), filePath: z.string(), contentType: z.string().optional() }),
  z.object({ mode: z.literal('graphql'), query: z.string(), variables: z.string().default('') }),
]);
export type RequestBody = z.infer<typeof BodySchema>;
export type BodyMode = RequestBody['mode'];

// ---------------------------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------------------------

export const OAuth2ConfigSchema = z.object({
  type: z.literal('oauth2'),
  grantType: z.enum(['authorization_code', 'client_credentials', 'device_code', 'password']),
  authUrl: z.string().default(''),
  tokenUrl: z.string().default(''),
  deviceAuthUrl: z.string().default(''),
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  username: z.string().default(''),
  password: z.string().default(''),
  scope: z.string().default(''),
  audience: z.string().default(''),
  redirectUri: z.string().default('http://127.0.0.1:0/callback'),
  usePkce: z.boolean().default(true),
  clientAuthentication: z.enum(['basic', 'body']).default('body'),
  tokenPrefix: z.string().default('Bearer'),
  autoRefresh: z.boolean().default(true),
  extraParams: z.array(KeyValueSchema).default([]),
});
export type OAuth2Config = z.infer<typeof OAuth2ConfigSchema>;

export const JWT_ALGORITHMS = ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512', 'ES256', 'ES384'] as const;

export const AuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inherit') }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('basic'), username: z.string().default(''), password: z.string().default('') }),
  z.object({ type: z.literal('bearer'), token: z.string().default(''), prefix: z.string().default('Bearer') }),
  z.object({
    type: z.literal('apikey'),
    key: z.string().default(''),
    value: z.string().default(''),
    in: z.enum(['header', 'query']).default('header'),
  }),
  OAuth2ConfigSchema,
  z.object({
    type: z.literal('jwt'),
    algorithm: z.enum(JWT_ALGORITHMS).default('HS256'),
    /** HMAC secret or PEM private key (usually a {{$secret:...}} reference). */
    secret: z.string().default(''),
    secretBase64: z.boolean().default(false),
    payload: z.string().default('{}'),
    header: z.string().default('{}'),
    expiresInSeconds: z.number().int().nonnegative().optional(),
    addTo: z.enum(['header', 'query']).default('header'),
    headerPrefix: z.string().default('Bearer'),
    queryParam: z.string().default('token'),
  }),
  z.object({
    type: z.literal('awsv4'),
    accessKeyId: z.string().default(''),
    secretAccessKey: z.string().default(''),
    sessionToken: z.string().default(''),
    region: z.string().default('us-east-1'),
    service: z.string().default('execute-api'),
  }),
  z.object({ type: z.literal('digest'), username: z.string().default(''), password: z.string().default('') }),
  z.object({
    type: z.literal('clientcert'),
    certPath: z.string().default(''),
    keyPath: z.string().default(''),
    pfxPath: z.string().default(''),
    passphrase: z.string().default(''),
  }),
]);
export type Auth = z.infer<typeof AuthSchema>;
export type AuthType = Auth['type'];

/** Auth fields that hold sensitive material. Literal values in these fields are never persisted in plaintext. */
export const SENSITIVE_AUTH_FIELDS: Record<string, readonly string[]> = {
  basic: ['password'],
  bearer: ['token'],
  apikey: ['value'],
  oauth2: ['clientSecret', 'password'],
  jwt: ['secret'],
  awsv4: ['secretAccessKey', 'sessionToken'],
  digest: ['password'],
  clientcert: ['passphrase'],
};

// ---------------------------------------------------------------------------------------------
// Tests (scriptless assertions) and extraction (request chaining)
// ---------------------------------------------------------------------------------------------

export const ASSERTION_SOURCES = [
  'status',
  'responseTime',
  'body',
  'json',
  'header',
  'contentType',
  'size',
  'cookie',
] as const;
export type AssertionSource = (typeof ASSERTION_SOURCES)[number];

export const ASSERTION_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'exists',
  'notExists',
  'matches',
  'isType',
  'isJson',
  'arrayContains',
  'lengthEq',
  'schema',
] as const;
export type AssertionOperator = (typeof ASSERTION_OPERATORS)[number];

export const AssertionSchema = z.object({
  id: z.string(),
  kind: z.literal('assert'),
  enabled: z.boolean().default(true),
  source: z.enum(ASSERTION_SOURCES),
  /** JSONPath for `json`, header name for `header`, cookie name for `cookie`. */
  path: z.string().default(''),
  operator: z.enum(ASSERTION_OPERATORS),
  expected: z.string().default(''),
  description: z.string().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

export interface AssertionGroup {
  id: string;
  kind: 'group';
  enabled: boolean;
  name?: string;
  logic: 'and' | 'or';
  items: Array<Assertion | AssertionGroup>;
}

export const AssertionGroupSchema: z.ZodType<AssertionGroup, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: z.literal('group'),
    enabled: z.boolean().default(true),
    name: z.string().optional(),
    logic: z.enum(['and', 'or']).default('and'),
    items: z.array(z.union([AssertionSchema, AssertionGroupSchema])).default([]),
  }),
);

export const VARIABLE_SCOPES = ['runtime', 'environment', 'collection', 'global'] as const;
export type WritableVariableScope = (typeof VARIABLE_SCOPES)[number];

export const ExtractionSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  variable: z.string(),
  source: z.enum(['json', 'header', 'status', 'regex', 'cookie', 'body']),
  /** JSONPath (json), header/cookie name, or a regular expression with an optional capture group (regex). */
  path: z.string().default(''),
  scope: z.enum(VARIABLE_SCOPES).default('runtime'),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

// ---------------------------------------------------------------------------------------------
// Settings, scripts
// ---------------------------------------------------------------------------------------------

export const RequestSettingsSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  followRedirects: z.boolean().optional(),
  maxRedirects: z.number().int().nonnegative().optional(),
  /** `false` disables TLS verification for this request only. Never changed silently. */
  verifyTls: z.boolean().optional(),
  encodeUrl: z.boolean().optional(),
  decompress: z.boolean().optional(),
  useCookieJar: z.boolean().optional(),
  maxResponseBytes: z.number().int().positive().optional(),
});
export type RequestSettings = z.infer<typeof RequestSettingsSchema>;

export const ScriptsSchema = z.object({
  pre: z.string().default(''),
  post: z.string().default(''),
});
export type Scripts = z.infer<typeof ScriptsSchema>;

export const RunnerSettingsSchema = z.object({
  iterations: z.number().int().positive().default(1),
  delayMs: z.number().int().nonnegative().default(0),
  concurrency: z.number().int().positive().default(1),
  stopOnFailure: z.boolean().default(false),
});
export type RunnerSettings = z.infer<typeof RunnerSettingsSchema>;

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

const MetaSchema = z.object({
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const HttpRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
  sortKey: z.number().default(0),
  method: z.string().min(1).default('GET'),
  url: z.string().default(''),
  params: z.array(KeyValueSchema).default([]),
  headers: z.array(KeyValueSchema).default([]),
  body: BodySchema.default({ mode: 'none' }),
  auth: AuthSchema.default({ type: 'inherit' }),
  cookies: z.array(KeyValueSchema).default([]),
  scripts: ScriptsSchema.default({}),
  tests: AssertionGroupSchema.optional(),
  extractions: z.array(ExtractionSchema).default([]),
  variables: z.array(KeyValueSchema).default([]),
  settings: RequestSettingsSchema.default({}),
  docs: z.string().default(''),
  meta: MetaSchema.extend({
    openapi: z.object({ operationId: z.string().optional(), path: z.string(), method: z.string(), hash: z.string().optional() }).optional(),
  }).default({}),
});
export type HttpRequest = Omit<z.infer<typeof HttpRequestSchema>, 'tests'> & { tests: AssertionGroup };

export const FolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  parentId: z.string().nullable().default(null),
  sortKey: z.number().default(0),
  description: z.string().default(''),
  variables: z.array(KeyValueSchema).default([]),
  headers: z.array(KeyValueSchema).default([]),
  auth: AuthSchema.default({ type: 'inherit' }),
  scripts: ScriptsSchema.default({}),
  tests: AssertionGroupSchema.optional(),
  settings: RequestSettingsSchema.default({}),
  meta: MetaSchema.default({}),
});
export type Folder = Omit<z.infer<typeof FolderSchema>, 'tests'> & { tests: AssertionGroup };

export const CollectionSourceSchema = z.object({
  type: z.enum(['openapi', 'postman', 'insomnia', 'thunder', 'bruno', 'hoppscotch', 'curl', 'reqvyn']),
  location: z.string().optional(),
  importedAt: z.string().optional(),
  hash: z.string().optional(),
});

/** Collection-level configuration (stored in `collection.json`). */
export const CollectionInfoSchema = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  variables: z.array(KeyValueSchema).default([]),
  headers: z.array(KeyValueSchema).default([]),
  auth: AuthSchema.default({ type: 'none' }),
  scripts: ScriptsSchema.default({}),
  tests: AssertionGroupSchema.optional(),
  settings: RequestSettingsSchema.default({}),
  runner: RunnerSettingsSchema.default({}),
  meta: MetaSchema.extend({ source: CollectionSourceSchema.optional() }).default({}),
});
export type CollectionInfo = Omit<z.infer<typeof CollectionInfoSchema>, 'tests'> & { tests: AssertionGroup };

export const CollectionSchema = CollectionInfoSchema.extend({
  folders: z.array(FolderSchema).default([]),
  requests: z.array(HttpRequestSchema).default([]),
});
export type Collection = CollectionInfo & { folders: Folder[]; requests: HttpRequest[] };

export const EnvironmentSchema = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  variables: z.array(KeyValueSchema).default([]),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const WorkspaceConfigSchema = z.object({
  schemaVersion: z.number().int().default(SCHEMA_VERSION),
  variables: z.array(KeyValueSchema).default([]),
  activeEnvironmentId: z.string().nullable().optional(),
  collectionOrder: z.array(z.string()).default([]),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export type CollectionItem = { kind: 'folder'; item: Folder } | { kind: 'request'; item: HttpRequest };
