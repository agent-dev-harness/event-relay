# Refine: second pass over a commit's comments

Another agent wrote a commit without restrictions on comments. Its comments are the record of what that agent knew. Your job is to move that knowledge somewhere more reliable than prose, without losing any of it, and without changing what the code does.

Work only on the comments and docstrings that commit added or changed (the pass-1 diff). Comments that existed before it are covered by **Existing comments** below.

## Why agents don't keep comments

- **Comments are unchecked.** Nothing fails when a comment becomes wrong. A stale comment is then read as the spec, and the next agent "fixes" correct code back to match it.
- **Agents invent reasons.** A model asked to explain will produce a plausible why even when it doesn't know the real one.
- **Code is still written for humans.** People must be able to step in at any time, so the knowledge must stay visible to them.

## The process, for each comment block the commit added

### 1. Name the knowledge

Write down the single fact the comment carries. Then classify it:

- **It restates what the code does.** Rename or restructure until it's unnecessary. Judge this from where the reader stands: for something exported, the reader is a caller who sees only the signature. If the comment tells a caller something the signature doesn't (what happens when an option is left out, a format, an obligation), it does not restate the code; it is interface documentation, see **Docstrings**.
- **It narrates the edit** ("fixed null case", "changed to use X"). Put it in the commit message.
- **It's a why the author was guessing at.** Don't keep it. If it matters, propose it (step 3) and say the source is unknown.
- **It's a why with a source**: the task, the human, the code, a test, a doc in the repo. Continue to step 2.

Every comment block ends in the record (see **Record**). Deleting one without an entry is not an outcome.

### 2. Try each form, strongest first

Stop at the first one that captures the knowledge.

1. **Types.** If the knowledge is a constraint on values, express it in the type system. It only counts if the checker rejects the wrong use. A type that just moves an unchecked cast out of sight is not a check: keep the cast visible and use the forms below.
2. **Guard with an error message.** If the hazard is that a caller's mistake fails *silently*, make it fail loudly. A guard is for mistakes a caller can make: misusing an API, or bad configuration at startup. Input from outside the program (payloads, responses, files) is checked where it is parsed, and refused or ignored there; don't add a check deeper in that only fires on bad outside input. Before adding a guard, find where its error goes when it fires; if that is the crash of a long-running process, use a test instead. Don't turn a deliberate fallback into a failure: if the code already chooses a safe default for unexpected input, pin that choice with a test.
3. **Structure.** If callers shouldn't need to know about a hazard at all, hide it behind an interface (an adapter around a quirky dependency, with the raw client held privately) so the safe path is the only obvious path. Only when it prevents a real bypass: several call sites, or the raw thing reachable elsewhere.
4. **Test.** If a behaviour must keep holding, write a test that fails when it doesn't. Share constants between code and test so "find usages" links one to the other.
5. **Name.** Names say what a thing is or does, not why it exists. Don't load a hazard or rationale into a name. Test names are the exception: a test name states the behaviour it checks, as a full sentence if needed.
6. **Commit message.** History and provenance: how something was discovered, what was tried.

### 3. If nothing fits, propose

Some knowledge has nothing in the code to attach to: a decision not to do something, a reason from outside the code, a deliberate trade-off. Remove the comment and record it as `proposed`, with the text you would keep, why it can't be code, and its source. A later pass decides whether it comes back.

### 4. Check for substitutes

Check you haven't moved the comment into a name stretched into a sentence, a docstring that carries more than the interface, or prose in a string other than an error message tied to its check.

## Docstrings

A docstring on something exported may document its interface: what a caller passes, what it gets back, what it must do, and what it can rely on, including obligations the types can't show ("null when …", "throws if …", "never trusted"). Keep or trim such a docstring to that, and record it as `interface-doc-kept`. It must not carry:

- a reason: a clause with *so*, *because*, *since*, *otherwise*, *to avoid*, *in case*;
- a fact about another system (a vendor, a runtime, a consumer) offered as the explanation for the behaviour;
- history.

State what the caller sees, not why. "True for a 401, or for a 2xx whose body isn't JSON" is interface; "Azure DevOps answers a bad token with a sign-in page" is a vendor fact, and goes through step 1.

A docstring on something not exported is an ordinary comment.

## Existing comments

Don't reword or delete comments that existed before the commit. If the commit made one wrong, correct what it says, without adding a reason or fact it didn't carry, and record it as `kept` with what you changed.

## Behaviour

Keep the commit's behaviour. Tests may change in how they are wired (imports, helpers, casts for deliberately invalid input) and in the wording of an error message you changed, but not in any expected result. `ci/check.sh` must pass (you may run `npm run lint`, `npm run build` and `npm test` directly).

## Record

Write a JSON file at the path you were given:

```json
{
  "entries": [
    {
      "file": "src/sources/github/poller.ts",
      "line": 21,
      "text": "the comment's full text, as the commit left it",
      "disposition": "one of the values below",
      "where": "where the knowledge is now: file:line, a test name, or 'commit message'",
      "reason": "one line: why this disposition",
      "proposedText": "only for proposed",
      "source": "only for proposed: the task, the human, a file in the repo, or 'unknown'"
    }
  ]
}
```

Dispositions: `type`, `guard`, `structure`, `test`, `name`, `commit-message`, `interface-doc-kept`, `kept`, `proposed`, `deleted-restates`, `deleted-wrong`.

One entry per comment block the commit added, plus one per existing comment you changed. `deleted-restates` and `deleted-wrong` need a reason a reviewer can check.

## Worked example

The comment:

```python
# Library truncates silently past 4096 bytes; see test_long_payload_not_truncated
```

A known why with a source. The hazard is silent and the raw client is used in several places, so a guard and an adapter:

```python
class VendorClient:
    BYTE_LIMIT = 4096

    def __init__(self, raw_client):
        self._raw_client = raw_client

    def send(self, payload: bytes) -> None:
        for chunk in self._split_into_chunks(payload):
            self._send_within_limit(chunk)

    def _split_into_chunks(self, payload: bytes) -> list[bytes]:
        return [payload[start:start + self.BYTE_LIMIT]
                for start in range(0, len(payload), self.BYTE_LIMIT)]

    def _send_within_limit(self, chunk: bytes) -> None:
        if len(chunk) > self.BYTE_LIMIT:
            raise ValueError(
                f"Vendor silently truncates payloads over {self.BYTE_LIMIT} bytes; "
                f"refusing to send {len(chunk)}"
            )
        self._raw_client.send(chunk)
```

```python
def test_payload_over_vendor_byte_limit_arrives_intact():
    payload = b"x" * (VendorClient.BYTE_LIMIT + 1)
    client = VendorClient(fake_raw_client)
    client.send(payload)
    assert fake_raw_client.received_bytes() == payload
```

The commit message records how the truncation was found. Record entry: `"disposition": "guard"`, `"where": "VendorClient._send_within_limit; test_payload_over_vendor_byte_limit_arrives_intact"`.
