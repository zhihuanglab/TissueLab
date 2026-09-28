Analyze ONE training-set error of the current downstream analysis script.

Thumbnail attached: {{HAS_IMAGE}}

{{CASE_TEXT}}

Answer as JSON only:
```json
{
  "failure_pattern": "one sentence naming the recurring pattern this error most likely belongs to",
  "evidence": "what in the image and/or the analysis details supports that (quantities, positions, sizes)",
  "fixable_downstream": true,
  "candidate_rule": "if fixable: the general rule that would prevent this class of error, with concrete parameters",
  "confidence": "high | medium | low"
}
```
