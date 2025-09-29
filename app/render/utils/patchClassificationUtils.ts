export interface PatchClassificationData {
  class_id: number[];
  class_name: string[];
  class_hex_color: string[];
  class_counts?: number[];
}

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
    const safeColor = typeof colorValue === 'string' && colorValue.trim() !== '' ? colorValue : '#aaaaaa';
    const idValue = typeof data.class_id?.[index] === 'number' ? data.class_id[index] : normalized.class_id.length;

    normalized.class_id.push(idValue);
    normalized.class_name.push(name);
    normalized.class_hex_color.push(safeColor);
    if (normalized.class_counts) {
      normalized.class_counts.push(data.class_counts?.[index] ?? 0);
    }
    seen.set(key, normalized.class_name.length - 1);
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
    merged.class_hex_color.push(add.class_hex_color[index]);
    if (merged.class_counts) {
      merged.class_counts.push(add.class_counts?.[index] ?? 0);
    }
    seen.set(key, merged.class_name.length - 1);
  });

  return merged;
};
