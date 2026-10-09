# event-relay


## Scope

### Responsible for

1. **Sources:** being the only part that deals with event sources.
2. **Normalizing:** turning every source's events into the shape set by the event contract.
3. **Subscriptions:** letting subscribers choose which events they want, and change or cancel
   that choice.
4. **Notifying:** delivering each event to the subscribers.
5. **Rate Limiting:** define how often the subscribers can be notified.

### Not responsible for

Knowing who consumes the events. The relay produces events that make sense on their own: a CI
check changing state is the event. Consumers such as agent-core import the contract; the relay
imports nothing from them.

## Design

```
Source → emit → dedupe → match subscriptions → per-subscriber queue (coalesce, cap) → Sink
```

| Part | What it does |
|---|---|
| **Contract** (`src/contract.ts`) | `RelayEvent`, `KindSpec`, `Source`, `Sink`. It imports nothing, so consumers can use it without loading the relay. |
| **Sources** (`src/sources/<name>/`) | Each source owns how its events arrive (webhook, polling, …) and turns them into changes: a redelivered payload or a repeat of the current state produces no event. Text written by third parties goes in `untrusted`, never in `data`. |
| **Kinds** | Each source declares the kinds it emits. A kind's `KindSpec` says whether its events coalesce (a subscriber only gets the latest per key), which event goes when a queue is full, and how long an event may wait. |
| **Core** (`src/core/`) | Subscriptions, delivery and resource limits. It must not import a source; `scripts/check-boundary.ts` enforces that, so a source can move to its own package without changing the core. |

### Resource limits

Every buffer the relay keeps has a cap (`RelayLimits`, defaults in `src/core/limits.ts`): number
of subscriptions, events queued per subscriber, gap subjects per subscriber, event size, and
event ids remembered for dedupe. Deliveries to one subscriber are at least `minDeliveryIntervalMs`
apart and never overlap. Sources cap their own ingestion: `GitHubSource` refuses bodies over
`maxPayloadBytes` before parsing them and remembers at most `maxTrackedChecks` check states.

Nothing is dropped silently. When the relay drops an event (queue full, too large, expired, or
the sink failed), the subscriber's next batch starts with a `relay.gap` event naming the subject
and kinds it lost. Its view of that subject is then incomplete and it should fetch the current
state itself. Gaps for more subjects than `maxGapSubjectsPerSubscriber` collapse into one gap for
`ALL_SUBJECTS`.

Delivery is best effort: events can arrive late or out of order. Compare `occurredAt` and
`observedAt` to spot stale ones.

## Entrypoints

| Import | Contents |
|---|---|
| `@agent-dev-harness/event-relay` | `Relay`, `RelayLimits`, `DEFAULT_LIMITS`, and everything in `./contract` |
| `@agent-dev-harness/event-relay/contract` | `RelayEvent`, `Subject`, `KindSpec`, `Source`, `SourceContext`, `Sink`, `SubscriptionFilter`, `SubscriptionOptions`, `GapEvent`, `GapData`, `GapReason`, `GAP_KIND`, `ALL_SUBJECTS` |
| `@agent-dev-harness/event-relay/github` | `GitHubSource`, `CI_STATUS_CHANGED`, `CiStatusChanged` |

```ts
import { createServer } from "node:http";
import { Relay } from "@agent-dev-harness/event-relay";
import { CI_STATUS_CHANGED, GitHubSource } from "@agent-dev-harness/event-relay/github";

const relay = new Relay();
const github = new GitHubSource({ webhookSecret: process.env.GITHUB_WEBHOOK_SECRET! });
await relay.addSource(github);
createServer(github.handler).listen(8080);

relay.subscribe("pr-123", {
  filter: { kinds: [CI_STATUS_CHANGED], subjects: [{ type: "commit", key: `owner/repo@${headSha}` }] },
  sink: { deliver: async (batch) => console.log(batch) },
});
```

Calling `subscribe` again with the same id changes that subscription, for example to follow a
new head commit; `cancel(id)` ends it.

### Event kinds

| Kind | Source | Subject | Coalesces per |
|---|---|---|---|
| `ci.status_changed` | GitHub `check_run` and `status` webhooks | `commit`, `<owner>/<repo>@<sha>` | commit and check |
| `relay.gap` | the relay | the subject events were lost for | never; at most one per subject per batch |

## Development

Node.js 22.12 or later.

```bash
npm install        # also builds dist/ via the prepare script
npm run lint       # tsc, ESLint, check-explicit-any, boundary guard
npm test           # vitest
npm run build      # dist/: ESM bundles plus .d.ts
```

`ci/check.sh` is the merge gate; CI runs only that. To release, bump `version` in
`package.json` in a PR; when it merges, CI tags that commit `v<version>`.
