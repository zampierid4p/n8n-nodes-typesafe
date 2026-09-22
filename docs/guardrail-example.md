# Example: guardrail on prompt input

A generic wiring example.

How to wire this node as a guardrail that screens incoming prompts before they reach an

LLM. No extra node type is needed. One request carries a battery of questions, then
thresholds are applied in a Code node and a Switch routes the item.

Import [`guardrail-workflow.json`](./guardrail-workflow.json) to get the wiring below. The
sample input is a placeholder, and the categories and thresholds are starting points to
replace with your own policy.

## Wiring

```
Trigger -> Set (the prompt) -> TypeSafe -> Code (thresholds) -> Switch -> pass
                                                                          review
                                                                          block
                                                                          support
```

## The question battery

Four independent questions in one request. They are answered in parallel, so the battery
costs about what a single question costs.


| ID          | Type   | Returns                                              |
| ------------- | -------- | ------------------------------------------------------ |
| `unsafe`    | Noul   | probability the prompt should be declined            |
| `jailbreak` | Noul   | probability the prompt attacks the system prompt     |
| `severity`  | Score  | position on the levels you define, plus a confidence |
| `reason`    | Choice | which category fired, plus a confidence              |

Put the policy wording in each question's instructions and criteria rather than in the
state. The state should carry only the content being judged, which keeps the request small
since the policy would otherwise be resent on every call.

## Routing

```javascript
// Starting points. Tune them against your own labelled traffic.
const REVIEW_AT = 0.15;
const BLOCK_AT = 0.5;
const SEVERITY_BLOCK = 2.5;
const JAILBREAK_AT = 0.5;

const REQUIRED = ['unsafe', 'jailbreak', 'severity', 'reason'];

return $input.all().map((item) => {
  // With Simplify off and a single output, the node returns { model, answers, usage },
  // so the answers are nested rather than spread onto the item.
  const answers = item.json.answers;

  // No answers at all means the request failed; a missing id means a question went
  // unanswered. Either way there is nothing to judge the prompt on, so a person does.
  // Reading a missing signal as zero would send it to pass, which turns an outage into
  // an open gate.
  const missing = answers ? REQUIRED.filter((id) => answers[id] === undefined) : REQUIRED;
  if (missing.length > 0) {
    return { json: { decision: 'review', missing, error: item.json.error ?? null } };
  }

  const unsafe = answers.unsafe.noul;
  const jailbreak = answers.jailbreak.noul;
  const severity = answers.severity.score;
  const category = answers.reason.choice;
  const categoryConfidence = answers.reason.confidence;

  let decision = 'pass';
  if (category === 'self_harm' && unsafe >= REVIEW_AT) decision = 'support';
  else if (unsafe >= BLOCK_AT || severity >= SEVERITY_BLOCK) decision = 'block';
  else if (unsafe >= REVIEW_AT || jailbreak >= JAILBREAK_AT) decision = 'review';

  return {
    json: {
      decision,
      // Keep the numbers that drove the decision, so a blocked prompt can be explained
      // later without rerunning anything.
      signals: { unsafe, jailbreak, severity, category, categoryConfidence },
      model: item.json.model,
      usage: item.json.usage,
    },
  };
});
```

Attach the Switch to `{{ $json.decision }}` and give it one output per value.

**A missing signal goes to review, not pass.** If the API call fails and the TypeSafe node
has Continue On Fail set, the item arrives as `{ error }` with no answers at all; a
question can also go unanswered on its own. Reading either as a zero would route it to
pass, so an outage would quietly open the gate. The check is explicit instead, and the
item carries which signals were missing so the queue can show why.

## Notes

**Leave Simplify off.** It returns only the answer value and drops the probabilities and
confidence, which are the fields the thresholds read.

**A Score is a position, not a level.** It can come back between two levels, so
`severity >= 2.5` is a usable gate. Do not round to the nearest level before comparing.

**A Noul has no separate confidence.** The probability is the confidence, so a value near
0.5 means yes and no are about equally likely rather than a medium result.

**Do not assume 0.5 is the right cut.** Sweep the thresholds on your own labelled traffic
and keep a review band rather than a single block or pass boundary.

**Self-harm routes to support, not block.** Blocking someone in crisis is a worse outcome
than putting the item in front of a person.

**Set Max Retries.** Rate limits and transport blips are expected on a path that runs on
every request.

## Further reading

TypeSafe's own [guardrails cookbook](https://docs.typesafe.ai/cookbooks/llm_guardrails)
covers the question design in more depth, including screening model output as well as
input, and discusses how to pick thresholds.
