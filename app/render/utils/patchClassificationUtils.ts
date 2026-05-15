export interface PatchClassificationData {
  class_id: number[];
  class_name: string[];
  class_hex_color: string[];
  class_counts?: number[];
}

// Negative control constants
export const NEGATIVE_CONTROL_CLASS_NAME = 'Negative control';
export const NEGATIVE_CONTROL_COLOR = '#aaaaaa';

/**
 * Check if a class name is the Negative control class
 */
export const isNegativeControl = (className: string | undefined | null): boolean => {
  return className === NEGATIVE_CONTROL_CLASS_NAME;
};

/**
 * Generic catch-all aliases the agent (or older clients) sometimes emit
 * instead of the canonical "Negative control" — normalize them here so the
 * UI never ends up with duplicate / parallel catch-all classes.
 */
const CATCH_ALL_ALIASES = new Set([
  'others',
  'other',
  'unknown',
  'background',
  'misc',
  'none',
  'negative',
  'rest',
  'n/a',
  'na',
]);

/**
 * Normalize a class name: catch-all aliases (Others, Unknown, Background, …)
 * map to the canonical "Negative control"; everything else passes through.
 */
export const normalizeClassName = (name: string): string => {
  const trimmed = (name || '').trim();
  if (!trimmed) return trimmed;
  return CATCH_ALL_ALIASES.has(trimmed.toLowerCase()) ? NEGATIVE_CONTROL_CLASS_NAME : trimmed;
};

/**
 * Get the color for a class, ensuring Negative control always uses the fixed color
 */
export const getClassColor = (className: string | undefined | null, defaultColor: string = NEGATIVE_CONTROL_COLOR): string => {
  return isNegativeControl(className) ? NEGATIVE_CONTROL_COLOR : defaultColor;
};

export const normalizePatchClassificationData = (
  data: PatchClassificationData | null | undefined
): PatchClassificationData => {
  if (!data) {
    return {
      class_id: [],
      class_name: [],
      class_hex_color: [],
      class_counts: undefined,
    };
  }

  const normalized: PatchClassificationData = {
    class_id: [],
    class_name: [],
    class_hex_color: [],
    ...(Array.isArray(data.class_counts) ? { class_counts: [] as number[] } : {}),
  };

  const seen = new Map<string, number>();

  data.class_name.forEach((rawName, index) => {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
      return;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      const existingIndex = seen.get(key)!;
      if (normalized.class_counts) {
        normalized.class_counts[existingIndex] = (normalized.class_counts[existingIndex] ?? 0) + (data.class_counts?.[index] ?? 0);
      }
      return;
    }

    const colorValue = data.class_hex_color?.[index];
    const safeColor = typeof colorValue === 'string' && colorValue.trim() !== '' ? colorValue : NEGATIVE_CONTROL_COLOR;
    const idValue = typeof data.class_id?.[index] === 'number' ? data.class_id[index] : normalized.class_id.length;

    normalized.class_id.push(idValue);
    normalized.class_name.push(name);
    // Ensure 'Negative control' always uses the fixed color
    const finalColor = getClassColor(name, safeColor);
    normalized.class_hex_color.push(finalColor);
    if (normalized.class_counts) {
      normalized.class_counts.push(data.class_counts?.[index] ?? 0);
    }
    seen.set(key, normalized.class_name.length - 1);
  });

  // Final check: ensure any 'Negative control' class uses the fixed color
  normalized.class_name.forEach((name, index) => {
    if (isNegativeControl(name) && index < normalized.class_hex_color.length) {
      normalized.class_hex_color[index] = NEGATIVE_CONTROL_COLOR;
    }
  });

  return normalized;
};

export const mergePatchClassificationData = (
  existing: PatchClassificationData | null | undefined,
  incoming: PatchClassificationData | null | undefined
): PatchClassificationData => {
  const base = normalizePatchClassificationData(existing);
  const add = normalizePatchClassificationData(incoming);

  const seen = new Map<string, number>();
  const merged: PatchClassificationData = {
    class_id: [...base.class_id],
    class_name: [...base.class_name],
    class_hex_color: [...base.class_hex_color],
    ...(base.class_counts ? { class_counts: [...base.class_counts] } : {}),
  };

  merged.class_name.forEach((name, index) => {
    seen.set(name.toLowerCase(), index);
  });

  add.class_name.forEach((name, index) => {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      const existingIndex = seen.get(key)!;
      if (merged.class_counts) {
        merged.class_counts[existingIndex] = (merged.class_counts[existingIndex] ?? 0) + (add.class_counts?.[index] ?? 0);
      }
      return;
    }

    merged.class_id.push(add.class_id[index]);
    merged.class_name.push(name);
    // Ensure 'Negative control' always uses the fixed color
    const finalColor = getClassColor(name, add.class_hex_color[index]);
    merged.class_hex_color.push(finalColor);
    if (merged.class_counts) {
      merged.class_counts.push(add.class_counts?.[index] ?? 0);
    }
    seen.set(key, merged.class_name.length - 1);
  });

  // Final check: ensure any 'Negative control' class uses the fixed color
  merged.class_name.forEach((name, index) => {
    if (isNegativeControl(name) && index < merged.class_hex_color.length) {
      merged.class_hex_color[index] = NEGATIVE_CONTROL_COLOR;
    }
  });

  return merged;
};
