# n8n-nodes-typesafe-ai

Type-safe AI community node for [n8n](https://n8n.io). Call any OpenAI-compatible
model and get back an object that is **validated against your JSON Schema** — with
automatic re-prompting when the model gets it wrong.

## Node: Typesafe AI

Operation `Structured Output`:

1. Sends your prompt to `POST {baseUrl}/chat/completions` with
   `response_format: { type: "json_schema" }`.
2. Validates the returned JSON locally with [Ajv](https://ajv.js.org) against the
   same schema.
3. On a validation failure, feeds the errors back to the model and retries
   (configurable, default 1 retry).
4. Fails the item — or emits an `error` field with *Continue On Fail* — if the
   output never validates.

### Parameters

| Parameter | Description |
| --- | --- |
| Model | Model ID as exposed by the configured API, e.g. `gpt-4o-mini` |
| Prompt | The user message |
| Schema Name | Name reported to the API for the schema |
| JSON Schema | The schema the output must satisfy |

Options: `System Prompt`, `Temperature`, `Max Tokens`, `Max Retries`,
`Strict Schema`, `Put Output In Field`, `Return Raw Response`.

### Credential: Typesafe AI API

| Field | Notes |
| --- | --- |
| Base URL | Any OpenAI-compatible endpoint — OpenAI, Azure OpenAI, OpenRouter, Ollama, vLLM |
| API Key | Sent as `Authorization: Bearer …` |

Credential test calls `GET {baseUrl}/models`.

> **Strict Schema** (on by default) asks the provider to enforce the schema
> server-side. Providers that support it require `"additionalProperties": false`
> and every property listed in `"required"`. Turn it off for schemas or backends
> that don't comply — local Ajv validation still applies.

## Install

In n8n: **Settings → Community nodes → Install** → `n8n-nodes-typesafe-ai`.

## Development

```bash
npm install --ignore-scripts
npm run build
npm run lint
```

`--ignore-scripts` is recommended: `n8n-workflow` pulls in `isolated-vm`, which
needs a native build that this package does not use (it only needs the types).

To try the node in a local n8n instance:

```bash
npm run build && npm link
```

then `npm link n8n-nodes-typesafe-ai` inside `~/.n8n/custom` and restart n8n.

## License

[MIT](LICENSE) © Marco Zampieri
