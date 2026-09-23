# n8n-nodes-typesafe

[n8n](https://n8n.io) community node for [TypeSafe](https://docs.typesafe.ai)
System One models. Ask **typed questions** about your data and get back calibrated
probabilities your workflow can branch on — not free text you have to parse.

## Node: TypeSafe

Operation `Ask Questions` sends a `state` plus a map of questions to
`POST /v1/systemone` and returns one answer per question.

All questions in the node go out in **a single request** and are evaluated in
parallel against the same state. That is the point: per TypeSafe's
[parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md),
batching is dramatically cheaper and faster than one call per question, so put
independent questions in one node rather than chaining several.

### Question types

| Type | Answer | Use for |
| --- | --- | --- |
| **Noul** | `noul`: probability 0–1 that the answer is yes | whether a condition holds |
| **Choice** | `choice` + `probabilities` per option + `confidence` | picking one option from a set |
| **Score** | `score` (probability-weighted, can land between levels) + `legend` + `probabilities` + `confidence` | rating against ordered levels |

Options are written one per line as `option = description` (the description is
optional). Score levels are one per line, lowest to highest, at least two.

For structured `instructions` or `criteria` — see
[Advanced: structure](https://docs.typesafe.ai/primitives/advanced.md) — switch a
question to **Define as JSON** and supply the whole question object.

### Output

By default each item carries the full response:

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.92 },
    "department": {
      "type": "choice",
      "choice": "technical",
      "probabilities": { "billing": 0.08, "technical": 0.85, "sales": 0.07 },
      "confidence": 0.82
    }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

The **Simplify** option reduces this to `{ "is_urgent": 0.92, "department": "technical" }`.
It is off by default on purpose: it discards the probabilities and confidence that
tell you whether a judgment is safe to act on. See
[Confidence](https://docs.typesafe.ai/confidence.md) before turning it on.

### Questions as JSON

Set **Questions Source** to *JSON* to describe every question in one object, in
the same shape as the `questions` field of the TypeSafe API — so questions can be
pasted straight from its docs and cookbooks:

```json
{
  "is_urgent":   { "type": "noul",   "instructions": "Does this convey urgency?" },
  "department":  { "type": "choice", "instructions": "Which team should handle this?",
                   "criteria": { "billing": "Payments", "technical": "Bugs", "sales": null } },
  "frustration": { "type": "score",  "instructions": "How frustrated is the customer?",
                   "criteria": ["Calm", "Frustrated", "Very angry"] }
}
```

The key is the question ID. The JSON can be written in the node, or come from an
expression such as `{{ $json.questions }}` to ask different questions for each item.

With **One Output per Question**, the branches come from the keys of JSON written
in the node, in key order. JSON from an expression is only known once the node
runs, so the editor cannot draw its branches: the node shows one output, runs as
*Single Output*, and a notice says so.

Every question is checked the same way however it is written — fields, *Define as
JSON* on one question, or the whole object: a `type` of `noul`, `choice` or
`score`, non-empty `instructions`, a choice with at least two options, a score
with at least two levels. A definition that fails is rejected before any request
is sent.

Two things JSON does that you might not expect:

- **A repeated key is dropped silently.** JSON parsing keeps the last of two equal
  keys, so one question disappears without an error.
- **Numeric keys come first.** JavaScript orders keys like `"2"` or `"10"` ahead of
  the others, whatever order you wrote them in, and branch order follows.

### Answers are checked against the question

The node knows what it asked, and checks every answer against that before reading
a value:

- the answer's **type** must match the question — a noul answered as a choice fails
- its **value** must be usable — a noul is a number from 0 to 1, a choice is one of
  the options you listed, a score is a number between your first and last level
- an answer for a question that was never asked fails too

A failed check fails the item with an error naming the question, rather than
letting `"0.9"` as a string, or a missing value, reach a downstream comparison and
quietly evaluate false. With *Continue On Fail* that item arrives as `{ error }`,
which the [guardrail example](docs/guardrail-example.md) routes to review.

### Output mode

By default the node has one output carrying every answer. Set **Output Mode** to
*One Output per Question* and it grows one branch per question instead, labelled
with the question id, so each judgment can drive its own downstream logic —
`is_urgent` notifies, `department` assigns, `frustration` escalates.

This does not change how many API calls are made. Every question still travels
in a single request and is answered against the same state; only the delivery
side splits.

Each branch emits `{ questionId, ...answer }`, so `probabilities` and
`confidence` stay available where you branch on them. With **Simplify** on, a
branch emits `{ <id>: value }` instead. A question the model did not answer
leaves its branch empty rather than passing a blank item on. With *Continue On
Fail*, failures leave by the first branch, which is the convention n8n's own
Switch node uses.

> **Rewiring:** n8n stores connections by position, not by name. Adding,
> removing or reordering questions shifts the branches underneath existing
> links, and nothing will warn you — the wiring simply points at a different
> judgment. Check the connections after changing the question list.

### Also available as an AI Agent tool

The node declares `usableAsTool`, so n8n publishes a second node type built from
it: **TypeSafe Tool**. It carries the same questions and credential, its output
connects to an agent's tool port instead of the main flow, and it gains a *Tool
Description* field telling the agent when to reach for it.

That gives an agent a way to ask for a calibrated judgment — is this safe, which
of these, how severe — and get a number back, rather than deciding in prose.

### Options

| Option | Default | Notes |
| --- | --- | --- |
| Max Retries | `3` | Retries `429 Too Many Requests`, `529 Overloaded`, timeouts and dropped connections. Honours `retry-after` up to 15s per wait, otherwise exponential backoff, and stops once 30s have been spent waiting on one item. Other failures, including a cancelled execution, fail immediately. |
| Put Output in Field | — | Nest the result under a field |
| Simplify | `false` | Answer values only, dropping probabilities and confidence |

### Credential: TypeSafe API

| Field | Default |
| --- | --- |
| API Key | — (sent as `Authorization: Bearer …`) |
| Base URL | `https://api.typesafe.ai/v1` |

The credential test and the Model dropdown both call `GET /v1/models`. Versioned
IDs such as `jev-1.13.0` are accepted by the API even when the list only shows
aliases — set the Model field via expression to pin one.

> Community node, not affiliated with or endorsed by TypeSafe. "TypeSafe", "Jev"
> and the TypeSafe logo belong to TypeSafe; this package only talks to their
> public API. The MIT licence covers this package's own code.

## Install

In n8n: **Settings → Community nodes → Install** → `n8n-nodes-typesafe`.

## Development

```bash
npm install --ignore-scripts
npm run build
npm run lint
npm run lint:scan
npm test
```

`npm run lint:scan` runs the rules n8n's community scanner gates on, using the
scanner's own configuration against these sources. The scanner itself only
accepts a package that is already on npm, so without this a violation would only
surface after publishing. It runs on every push and before every release.

`npm test` builds first and runs against the compiled node, with Node's built-in
test runner and fake timers, so the retry waits are asserted exactly and the
suite does not spend real seconds asleep.

`--ignore-scripts` is recommended: `n8n-workflow` pulls in `isolated-vm`, whose
native build this package never uses — it only needs the types.

To try the node in a local n8n instance:

```bash
npm run build && npm link
```

then `npm link n8n-nodes-typesafe` inside `~/.n8n/custom` and restart n8n.

## License

[MIT](LICENSE) © Marco Zampieri
