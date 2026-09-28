The current downstream analysis script makes {{N_ERRORS}} errors on {{N_CASES}} training cases.
Below are reflections on individual errors, the skills already learned, rejected proposals to avoid,
and the current code.

## Reflections on error cases
{{REFLECTIONS}}

## Skills already in the knowledge base (all are active in the current code)
{{SKILLS}}

## Proposals rejected earlier (do not repeat them unchanged)
{{REJECTED}}

## Current analysis code
```python
{{CODE}}
```

## Task
Choose the ONE failure pattern with the strongest evidence that the downstream code can fix, and turn it
into a reusable skill. Then produce the complete updated script: same entry point
`analyze_medical_image(json_path) -> dict`, same input JSON, the predicted label still returned under the
key "{{LABEL_KEY}}" with the same label vocabulary, all existing skills preserved, the new rule added and
its parameters recorded in the returned dict so they are inspectable. The script must be self-contained
(standard library plus numpy allowed), must not read any file other than the given JSON, and must never
special-case individual case names.

Output, in this order:
1. A JSON block:
```json
{"name": "short_snake_case_name", "rule": "the rule in one or two sentences with its parameters",
 "rationale": "why this rule follows from the task criteria and the evidence",
 "expected_to_fix": ["case ids from the reflections this should fix"],
 "risk": "what kind of currently-correct case could this break, and why you think it will not"}
```
2. The complete script in ONE ```python block.
