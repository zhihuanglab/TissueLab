/**
 * Annotation utility functions
 */

/**
 * Ensures an annotation object has the required structure for Annotorious
 * Adds missing target.created and target.source fields if not present
 * 
 * @param annotation - The annotation object to validate
 * @returns The annotation with required fields guaranteed to exist
 */
export function ensureValidAnnotation(annotation: any) {
  return {
    ...annotation,
    target: {
      ...(annotation.target || {}),
      created: annotation.target?.created || new Date().toISOString(),
      source: annotation.target?.source || ''
    }
  };
}

