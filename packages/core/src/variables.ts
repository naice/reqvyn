/**
 * Variable reference syntax shared by the engine and the UI:
 *   {{name}}               – regular variable
 *   {{$uuid}}              – dynamic variable
 *   {{$secret:name}}       – explicit secret reference (resolved from secret storage / CI env)
 *   {{$env:NAME}}          – process environment variable (CLI / extension host)
 */
export const VARIABLE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function findVariableReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(VARIABLE_PATTERN)) if (m[1]) out.push(m[1]);
  return out;
}

export function isTemplate(text: string): boolean {
  VARIABLE_PATTERN.lastIndex = 0;
  return /\{\{\s*[^{}]+?\s*\}\}/.test(text);
}

export const DYNAMIC_VARIABLES: Array<{ name: string; description: string }> = [
  { name: '$uuid', description: 'Random UUID v4' },
  { name: '$guid', description: 'Alias of $uuid' },
  { name: '$timestamp', description: 'Unix timestamp in seconds' },
  { name: '$timestampMs', description: 'Unix timestamp in milliseconds' },
  { name: '$isoTimestamp', description: 'Current time as ISO-8601 string' },
  { name: '$randomInt', description: 'Random integer 0-1000 ($randomInt:min:max for a range)' },
  { name: '$randomFloat', description: 'Random float 0-1' },
  { name: '$randomEmail', description: 'Random e-mail address on example.com' },
  { name: '$randomString', description: 'Random alphanumeric string ($randomString:length)' },
  { name: '$randomBoolean', description: 'true or false' },
  { name: '$randomFirstName', description: 'Random first name' },
  { name: '$randomLastName', description: 'Random last name' },
  { name: '$date', description: 'Current date YYYY-MM-DD' },
  { name: '$secret:', description: 'Explicit secret reference, e.g. {{$secret:apiKey}}' },
  { name: '$env:', description: 'Process environment variable, e.g. {{$env:CI_TOKEN}}' },
];

/** Variable precedence from lowest to highest. Documented in docs/environments.md. */
export const VARIABLE_PRECEDENCE = [
  'global',
  'workspace',
  'collection',
  'folder',
  'environment',
  'data',
  'request',
  'runtime',
] as const;
export type VariableLayerName = (typeof VARIABLE_PRECEDENCE)[number];
