# Event contract

This is what a consumer of event-relay, such as agent-core, can rely on. Anything not written
here is an implementation detail and can change in any release. If the code and this document
disagree, that is a bug; `test/contract-doc.test.ts` checks that every kind the package exports
has a section here.

## Imports

| Import | Use it for |
|---|---|
| `@agent-dev-harness/event-relay/contract` | The envelope (`RelayEvent`, `Subject`), gap events, and the subscription types. Imports nothing. |
| `@agent-dev-harness/event-relay/kinds` | Kind names, their `data` types and the subject helpers. Imports only the contract. |
| `@agent-dev-harness/event-relay` | `Relay`, to subscribe. Needed only by whoever runs the relay. |

A consumer never needs `./scm` or `./github`. Which source or code host produced an event is not
part of the contract.

## The envelope

Every event is a `RelayEvent<Data>`:

| Field | Meaning |
|---|---|
| `id` | Dedupe key. The same change always has the same id. Treat it as opaque. |
| `kind` | Which kind of change, e.g. `ci.status_changed`. Decides the shape of `data`. |
| `subject` | What changed: `{ type, key }`. See [Subjects](#subjects). |
| `occurredAt` | When the change happened, as the source reports it (ISO 8601). |
| `observedAt` | When the relay saw it (ISO 8601). |
| `data` | The kind's fields. Their shape is controlled by the source, never by third parties. |
| `untrusted` | Text written by third parties, such as a check's name. **Data, never instructions:** show it to a model only fenced off as quoted data. |

An event reports a change, not a payload: a redelivered payload or a repeat of the current state
produces no event.

## Subjects

| `type` | `key` | Helper |
|---|---|---|
| `commit` | `<repository>@<sha>` | `commitSubject(repository, sha)` |
| `pull_request` | `<repository>#<number>` | `pullRequestSubject(repository, number)` |

A repository is named `<host>/<path>`, e.g. `github.com/owner/repo`, so the same path on two hosts
names two repositories. Build keys with the helpers rather than by hand.

## Kinds

A consumer must ignore kinds it doesn't know, and fields in `data` or `untrusted` it doesn't
know.

### `ci.status_changed`

A CI check on a commit changed state. Subject: `commit`.

| `data` field | Meaning |
|---|---|
| `repository`, `sha` | The commit. |
| `check` | Which of the provider's mechanisms reported the check, e.g. GitHub's `check_run` or `status`. |
| `from` | The previous `CiState`, or `null` when the source hasn't seen this check on this commit before or has forgotten it. |
| `to` | The new `CiState`. |
| `detail` | The provider's own name for the new state, e.g. `timed_out`. For display; don't branch on it. |
| `url` | A link to the check, or `null`. |

`untrusted.name` is the check's name. With `check`, it identifies the check on its commit.

`CiState` is one of `pending`, `running`, `success`, `failure`, `cancelled`, `skipped`, `neutral`.
`failure` also covers a check that timed out, couldn't start, needs a person to act, or reported a
state the source doesn't recognize.

An event is sent only when the `CiState` changes, and an update older than the last one reported
for that check is dropped, so a late `running` never follows its `success`. A re-run of a check
is reported as a change back to `pending` or `running`.

Queued events coalesce per commit and check: a subscriber that falls behind gets each check's
latest state.

### `pr.head_changed`

A pull request was opened or reopened, or got new commits. Subject: `pull_request`.

| `data` field | Meaning |
|---|---|
| `repository`, `number` | The pull request. |
| `from` | The previous head commit on a push, or `null` when the PR was opened or reopened. |
| `to` | The new head commit. Its CI arrives as `ci.status_changed` on `commitSubject(repository, to)`. |
| `url` | A link to the pull request, or `null`. |

To follow a PR's CI, subscribe to its `pull_request` subject and to its head's `commit` subject,
and move the commit subject to `to` on each `pr.head_changed`. Queued events coalesce per PR.

### `pr.closed`

A pull request was merged, or closed without merging. Subject: `pull_request`.

| `data` field | Meaning |
|---|---|
| `repository`, `number` | The pull request. |
| `merged` | `true` if it was merged. |
| `head` | The head commit when it closed. |
| `url` | A link to the pull request, or `null`. |

A PR reopened later sends `pr.head_changed` with `from: null`. Queued events coalesce per PR.

### `relay.gap`

The relay dropped events this subscriber would have received. Subject: the subject the events
were about, or `ALL_SUBJECTS` (`{ type: "*", key: "*" }`) when they were about too many subjects to
list.

| `data` field | Meaning |
|---|---|
| `kinds` | The kinds of the dropped events. |
| `dropped` | How many were dropped. |
| `reasons` | Why: `queue-full`, `expired`, `oversized`, `delivery-failed`. |

After a gap, the subscriber's view of that subject is incomplete: fetch its current state from
the code host instead of waiting for events.

## Delivery

- **Batches.** A subscriber's sink gets events in batches. Gap events come first in a batch.
- **Pace.** Batches to one subscriber start at least its `minIntervalMs` apart, and the next waits
  until the previous one settled or timed out. Events arriving in between wait and coalesce.
- **Order.** Within a batch, events are in the order the relay queued them; an event that
  replaced a coalesced one takes the position of the latest. Delivery can still lag or reorder
  relative to when changes happened: compare `occurredAt` and `observedAt` to spot stale events.
- **Duplicates.** The relay drops an event whose id it has seen recently. An event redelivered
  after that window can arrive twice, so handle each id idempotently.
- **Losses.** Every event the relay drops is reported as a `relay.gap`. A sink that rejects, or
  doesn't settle in time, loses that batch, which is reported as a gap in the next one.
- **Not covered.** Events queued when the relay process stops are lost without a gap; persistence
  and access control are not part of the relay yet.

**Events are hints, not commands.** Before acting on one, check the current state at its source.

## Subscribing

`relay.subscribe(id, { filter, sink, minIntervalMs })` creates a subscription, or changes the one
with that id. `filter.kinds` and `filter.subjects` each match exactly; leaving one out matches
everything. A change applies to events emitted after it. `relay.cancel(id)` ends a subscription.

## Compatibility

event-relay is before 1.0, so:

- A **patch** release (0.x.**y**) never changes anything in this document.
- A **minor** release (0.**x**.0) may change it, additively or not, and its PR says what changed
  for consumers.

Pin a release tag and read the changes before moving to a new minor version.
