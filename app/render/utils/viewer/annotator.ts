/**
 * Resolve the label stored on an annotation's `annotator` field.
 *
 * We store the user id (not a display name or email) so an annotation can
 * always be traced back to the exact account — names/emails can change or
 * collide, the uid never does. Falls back to "Unknown" when no user identity is
 * available (e.g. the user is signed out or their profile has not loaded yet).
 */
export function resolveAnnotatorLabel(opts: {
  userId?: string | null
}): string {
  const value = (opts.userId ?? "").trim()
  if (value && value !== "null") return value
  return "Unknown"
}
