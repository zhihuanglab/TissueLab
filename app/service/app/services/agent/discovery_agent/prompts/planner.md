# Round Planner

You are planning the next experimental round. Refer to the **Problem Definition** for the target variable, dataset, and available data sources.

## Current Experiment Log
```
{{EXPERIMENT_LOG}}
```

## Your Task
Based on the experiment history (or lack thereof), propose what to try in the next round.

Output a structured plan with:
1. **ROUND NUMBER**: The round number
2. **HYPOTHESIS**: Why this approach might work
3. **FEATURES**: List each feature with:
   - Name
   - Data source (which directory/file)
   - Extraction method (brief)
   - Whether it's new or from a previous round
4. **MODELS**: Which models to try (e.g., Ridge, ElasticNet, PLS, RF)
5. **FEATURE SETS**: If testing multiple subsets (e.g., all features, embeddings only, hand only)

## Guidelines
- Start simple (few features) and add complexity gradually
- If previous rounds exist, analyze what worked and what didn't
- Consider: what information is NOT yet captured?
- Embedding features are powerful but need regularization with small n
- Hand-crafted features are interpretable and can complement embeddings
- Each round should change ONE thing from the previous to isolate effects
- Prefer features with clear domain rationale for the target variable

## Output Format
Output ONLY the structured plan, no extra commentary. Keep it concise.
