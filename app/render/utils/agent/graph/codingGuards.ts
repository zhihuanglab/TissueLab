/** get_answer may return error strings after failed script gen — do not overwrite panel `generated_script`. */
export function isCodingAgentGenerationFailureAnswer(answer: string): boolean {
  const t = answer.trim()
  return t.startsWith("[ERROR]") || /^Error:/i.test(t)
}

/** `summary_answer` → post_answer puts prose in cur_answer; must not merge that into Coding Agent code fields. */
export function looksLikeCodingAgentGeneratedScript(answer: string): boolean {
  const t = answer.trim()
  if (!t || isCodingAgentGenerationFailureAnswer(answer)) return false
  return t.includes("def analyze_medical_image")
}
