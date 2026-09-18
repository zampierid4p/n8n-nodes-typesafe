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

### Options

| Option | Default | Notes |
| --- | --- | --- |
| Max Retries | `3` | Retries `429 Too Many Requests` and `529 Overloaded`, honouring `retry-after`, otherwise exponential backoff. Other statuses fail immediately. |
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
```

`--ignore-scripts` is recommended: `n8n-workflow` pulls in `isolated-vm`, whose
native build this package never uses — it only needs the types.

To try the node in a local n8n instance:

```bash
npm run build && npm link
```

then `npm link n8n-nodes-typesafe` inside `~/.n8n/custom` and restart n8n.

## License

[MIT](LICENSE) © Marco Zampieri
