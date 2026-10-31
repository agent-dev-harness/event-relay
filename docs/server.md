# Server endpoints

`event-relay-server` runs the relay as a local HTTP server, so subscribers in other processes or
containers can receive events. This document is the contract for its endpoints; the events
themselves are specified in [`contract.md`](contract.md). Both follow the same compatibility policy.

## Running it

```bash
GITHUB_TOKEN=… AZURE_DEVOPS_TOKEN=… event-relay-server relay.config.json
```

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "github": { "repositories": ["owner/repo"], "intervalMs": 30000 },
  "azureDevOps": { "organizationUrl": "https://dev.azure.com/org", "repositories": ["project/repo"] },
  "limits": { "minDeliveryIntervalMs": 1000 }
}
```

| Field | Meaning |
|---|---|
| `host`, `port` | Where to listen. Default `127.0.0.1:8787`. |
| `allowedHosts` | `Host` header names the server answers. Default: `localhost`, `127.0.0.1`, `[::1]` and `host`. |
| `github` | Poll these `owner/repo` repositories. `apiUrl` for GitHub Enterprise Server. Needs `GITHUB_TOKEN`, a personal access token that doesn't expire. |
| `azureDevOps` | Poll these `project/repository` repositories in `organizationUrl`. `auth` is `"pat"` (default; needs `AZURE_DEVOPS_TOKEN`, a PAT with Code and Build read) or `"az"`, which takes tokens from the Azure CLI's signed-in account (`az login`) and gets a new one before each expires. |
| `limits` | Any of `RelayLimits`. |

Configure at least one of `github` and `azureDevOps`. Tokens come only from the environment, so the
file can be committed. Each source polls every `intervalMs` (default 30 s): events arrive up to one
interval after the change. The first poll after the server starts only records the current
state, so a restart doesn't replay it as changes; what changed while the server was down is not
sent either, which is why subscribers fetch the current state when they connect (below).

**The server exits (status 1) when a source can't poll**, so it never looks like a host where
nothing happens. That is: a rejected token, a repository that isn't found, `az` failing to give a
token, a response it doesn't understand, or 10 failed polls in a row. A failure that may pass on
its own (network, a 5xx, rate limiting) is logged and retried. Open streams close when the server
exits, so subscribers see it too.

## Access

The server is meant to run on the machine of the agents that use it.

- It listens on loopback unless `host` says otherwise, and refuses to start on another address
  without `EVENT_RELAY_TOKEN`.
- When `EVENT_RELAY_TOKEN` is set, every request must send `Authorization: Bearer <token>`, or it
  gets `401`.
- A request whose `Host` is not in `allowedHosts` gets `403`. This stops a web page from reading
  the server through a DNS name it points at 127.0.0.1.

Any subscriber that gets in can read events for every configured repository.

## Endpoints

Errors are JSON, `{ "error": "<why>" }`, with these statuses: `400` bad request, `401` token,
`403` host, `404` unknown path or subscription, `405` wrong method, `413` body over 64 KiB.

### `GET /health`

`200 {"ok": true}` while the server runs.

### `GET /events`

Opens a subscription and streams it as [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html).

| Query parameter | Meaning |
|---|---|
| `kind` | A kind to receive, e.g. `ci.status_changed`. Repeat for more. Leave out for every kind. |
| `subject` | `<type>:<key>`, e.g. `pull_request:github.com/o/r#7` (URL-encoded). Repeat for more. Leave out for every subject. |
| `minIntervalMs` | Shortest time between two batches. Default and minimum: the relay's `minDeliveryIntervalMs`. |

The response is `200`, `content-type: text/event-stream`, and carries these messages:

| `event` | `data` |
|---|---|
| `subscribed` | `{"subscription": "<id>"}`. Always the first message of a stream. |
| `batch` | A JSON array of `RelayEvent`s: one delivery, gap events first, as in `contract.md`. |

Lines starting with `:` are keep-alive comments; ignore them.

**On `subscribed`, fetch the current state of what you follow.** The stream carries only changes
made after it opened. This holds on every connection, including an automatic reconnect after
the server restarted or the connection dropped: whatever happened in between is not sent.

Closing the connection ends the subscription. A subscriber that can't keep up loses batches,
which are reported as `relay.gap` in a later batch, as in `contract.md`.

### `PUT /subscriptions/{id}/filter`

Replaces an open stream's filter, e.g. to move from one PR head commit to the next.

```json
{ "kinds": ["pr.head_changed", "ci.status_changed"], "subjects": [{ "type": "pull_request", "key": "github.com/o/r#7" }] }
```

`kinds` and `subjects` are optional; an absent or empty list means everything. `204` on success,
`404` if no stream with that id is open on this server. The new filter applies to events emitted
after it: fetch the current state of a subject you just added.
