# Authentication

Set auth on the **Auth** tab of a request, or in the settings of a folder or collection
(**Settings (Variables, Headers, Auth, Scripts)…**). All fields accept variables.

## Inheritance

The default for requests and folders is **Inherit**: REQVYN walks up to the nearest folder with a
concrete auth type, then to the collection (whose default is **None**). The request editor shows the
effective auth and where it comes from.

An `Authorization` header you set explicitly on the request wins over header-based auth.

## Auth types

| Type | Fields | Result |
| --- | --- | --- |
| None | – | Nothing added |
| Basic | username, password | `Authorization: Basic …` |
| Bearer | token, prefix (default `Bearer`) | `Authorization: <prefix> <token>` |
| API key | key, value, add to header or query | `X-Api-Key: …` or `?api_key=…` |
| OAuth 2.0 | see below | `Authorization: Bearer <access token>` |
| JWT | algorithm, secret/key, payload, header | Signed token in a header or query param |
| AWS Signature v4 | access key, secret key, session token, region, service | Signed request |
| Digest | username, password | RFC 7616 challenge/response |
| Client certificate | PFX/P12 or cert + key, passphrase | mTLS |

### OAuth 2.0

Grant types:

- **Authorization code** with PKCE (on by default). The redirect must be a loopback URL; the default
  `http://127.0.0.1:0/callback` picks a free port. REQVYN opens the browser and waits for the callback.
  Interactive only – not available in the CLI.
- **Client credentials**
- **Device code** (RFC 8628): REQVYN shows the user code and verification URL, then polls.
- **Password** (resource owner)

Options: scope, audience, extra parameters, client authentication (`body` default, or `basic`), token
prefix, and automatic refresh with the refresh token.

Tokens are cached in SecretStorage. In folder/collection auth you can **Get token** and **Clear
token** manually; on send, a missing or expired token is fetched automatically.

The implicit grant is not supported; imported Insomnia implicit configurations become authorization
code.

### JWT

Algorithms: HS256/384/512, RS256/384/512, ES256/384. For HMAC the secret can be base64. Payload and
extra header are JSON; `expiresInSeconds` adds `exp`. Add the token as a header (prefix `Bearer`) or
as a query parameter (default `token`).

```json
{ "sub": "{{userId}}", "role": "admin" }
```

### AWS Signature v4

Region defaults to `us-east-1`, service to `execute-api`. The payload hash is part of the signature,
so sign after all body variables are resolved – REQVYN does this automatically.

### Digest

The first request is sent without credentials. After a `401` with a `WWW-Authenticate: Digest`
challenge, REQVYN retries once with the computed response (`qop=auth`).

### Client certificate

Either a PFX/P12 file or a PEM certificate plus key, optionally with a passphrase. Relative paths are
resolved against the store directory (e.g. the `.reqvyn/` folder), so they can be shared in a repo
without absolute paths. Do not commit private keys.

## Where secrets go

When you save, these fields are moved to the vault if they contain a literal value:

| Type | Fields |
| --- | --- |
| Basic, Digest | password |
| Bearer | token |
| API key | value |
| OAuth 2.0 | client secret, password |
| JWT | secret |
| AWS v4 | secret access key, session token |
| Client certificate | passphrase |

The file then contains `{{$secret:auth.<id>.<field>}}` instead of the value. Values that are already
variable references (e.g. `{{apiToken}}`) are left as they are – keep the actual value in a secret
environment variable.

In the CLI, provide vault values as `REQVYN_SECRET_*` environment variables (see [cli.md](cli.md)).
