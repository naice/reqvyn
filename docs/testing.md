# Testing, chaining and the runner

The **Tests** tab of a request has three sections: **Assertions**, **Extract variables (request
chaining)** and **Post-response script**. Pre-request scripts live on the **Pre-request** tab.
Collections and folders have the same on their *Scripts* and *Tests* tabs.

## Execution order

For every request:

1. Pre-request scripts – collection, then folders (outer to inner), then the request. They see the
   unresolved request and may change it.
2. Variables are resolved, auth is applied, the request is sent.
3. Extractions run.
4. Post-response scripts – again outermost first.
5. Assertions are evaluated (collection and folder assertions too, shown as `[collection: Name] …`).

An error in a pre-request script aborts the request. An error in a post-response script is recorded
as a failed test.

## Assertions (no code)

Each row: **source**, optional **path/name**, **operator**, **expected value**.

| Source | Path/name | Example |
| --- | --- | --- |
| status | – | `status eq 200` |
| responseTime | – | `responseTime lt 500` (ms) |
| body | – | `body contains "ok"` |
| json | JSONPath | `json $.data[0].id exists` |
| header | header name | `header Content-Type startsWith application/json` |
| contentType | – | `contentType contains json` |
| size | – | `size lte 10000` (bytes) |
| cookie | cookie name | `cookie session exists` |

Operators: `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `contains`, `notContains`, `startsWith`,
`endsWith`, `exists`, `notExists`, `matches` (regex, `/re/flags` allowed), `isType` (`string`,
`number`, `integer`, `boolean`, `null`, `array`, `object`, `undefined`), `isJson`, `arrayContains`,
`lengthEq`, `schema`.

`exists`, `notExists`, `isJson` and `schema` need no expected value (`schema` takes the JSON Schema
in the value field). Expected values may contain variables. Assertions can be grouped with **and**/**or**
and nested.

**JSON Schema:** a practical subset of draft-07 / 2019-09 / 2020-12 (types, properties, required,
items, enum, const, numeric/string/array limits, allOf/anyOf/oneOf/not, local `$ref`). Formats are
checked leniently; unknown keywords are ignored.

**JSONPath:** `$`, `.key`, `['key']`, `[0]`, `[-1]`, `[*]`, `..key`, slices `[0:2]`, unions `[0,2]`,
filters `[?(@.price < 10 && @.tag =~ /new/)]`, and `.length`. A bare path like `data.id` works too.

## Extract variables (request chaining)

| Source | Expression | Example |
| --- | --- | --- |
| json | JSONPath | `$.access_token` |
| header | header name | `Location` |
| status | – | |
| regex | regex on the body (group 1, or the whole match) | `id=(\d+)` |
| cookie | cookie name | `session` |
| body | – | whole body |

Target scope: **runtime** (default, session only), **environment**, **collection** or **global**.
A JSONPath matching several values stores a JSON array. A failed extraction shows up as a failed test
`Extract <name>` and a console warning.

Typical login chain: request *Login* extracts `$.token` into `token`; all other requests use bearer
auth `{{token}}` inherited from the collection.

## Scripts

Scripts are JavaScript and run in an isolated worker sandbox: no `require`, no `fetch`, no file or
network access, no `eval`/`new Function`. Limits: timeout 5 s (`reqvyn.scripts.timeoutMs`), memory
64 MB (`reqvyn.scripts.memoryLimitMb`), `sleep` up to 2 s per call. Scripts only run in trusted
workspaces and when `reqvyn.scripts.enabled` is on. Secrets are redacted from console output.

```js
// Pre-request
reqvyn.request.headers.set('X-Request-Id', '{{$uuid}}');   // resolved after the script runs
if (!reqvyn.env.get('token')) reqvyn.skipRequest();
```

```js
// Post-response
reqvyn.test('status is 200', () => {
  reqvyn.expect(reqvyn.response.status).toBe(200);
});
const body = reqvyn.response.json();
reqvyn.test('has items', () => reqvyn.expect(body.items).toHaveLength(3));
reqvyn.env.set('firstId', body.items[0].id);
```

### API reference

| API | Description |
| --- | --- |
| `reqvyn.env` (`reqvyn.environment`), `reqvyn.collectionVariables`, `reqvyn.globals` | `get`, `set`, `unset`, `has`, `replaceIn`, `toObject` |
| `reqvyn.variables` | `get` resolves across all scopes; `set` writes a runtime variable |
| `reqvyn.request` | `method`, `url`, `body`, `headers` (`get`, `set`, `add`, `upsert`, `remove`, `has`, `toObject`). Writable in pre-request only |
| `reqvyn.response` | Post-response only: `status`, `statusText`, `time`, `size`, `contentType`, `headers`, `cookies`, `text()`, `json()` |
| `reqvyn.test(name, fn)` | Register a test; `fn` may be async |
| `reqvyn.expect(value)` | Jest-style matchers (below) |
| `reqvyn.skipRequest()` | Pre-request only: do not send |
| `reqvyn.sleep(ms)` | Await a delay (max 2000 ms) |
| `reqvyn.info` | `phase` (`pre`/`post`), `eventName` |
| `console`, `btoa`, `atob`, `setTimeout`, `clearTimeout` | Standard helpers |

Matchers: `toBe`, `toEqual`, `toStrictEqual`, `toBeDefined`, `toBeUndefined`, `toBeNull`, `toBeNaN`,
`toBeTruthy`, `toBeFalsy`, `toBeGreaterThan(OrEqual)`, `toBeLessThan(OrEqual)`, `toBeOneOf`,
`toBeTypeOf`, `toBeInstanceOf`, `toContain`, `toHaveLength`, `toHaveProperty`, `toMatch`, `toThrow`;
`.not` negates.

**Postman compatibility:** a `pm` object offers a subset of the Postman API (`pm.environment`,
`pm.variables`, `pm.collectionVariables`, `pm.globals`, `pm.request`, `pm.response`, `pm.test`,
`pm.expect` with common chai chains such as `to.equal`, `to.have.status`, `to.be.above`,
`to.include`). Unsupported chai assertions throw an error rather than silently passing.
`pm.sendRequest`, `pm.cookies` and `require` are not available.

## Runner

**Run…** on a collection or folder (or the *Runner* tab of the collection settings) runs all requests
in tree order.

Options: iterations, delay between requests (ms), concurrency, stop on first failure, and a data file.

**Data files:** CSV, TSV or JSON (array of objects). Each row is one iteration; its columns are
available as variables in the *data* scope.

```csv
userId,expectedStatus
1,200
999,404
```

The result view lists every request with status, time and tests. Reports can be exported as **JSON**,
**JUnit XML** (for CI) or **HTML**. The same runner is available headless through the CLI
([cli.md](cli.md)).

## Limitations

- No `require` or network access in scripts; chaining between requests works through variables only.
- With concurrency > 1, runtime variables written by one request may not yet be visible to others.
- The script sandbox is a hardened Node `vm` in a worker thread – it protects against accidents and
  untrusted collections in practice, but it is not a security boundary on the level of a separate OS
  process sandbox. Review scripts from untrusted sources.
