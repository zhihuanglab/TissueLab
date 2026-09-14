import { ContentItem } from "@/store/slices/chat/workflowSlice";

/** Helpers for reading and updating workflow panel `ContentItem[]` arrays. */

export const getContentStringValue = (content: ContentItem[], key: string): string | null => {
  const value = content.find(item => item.key === key)?.value;
  return typeof value === "string" ? value : null;
};

/** True when a classifier has been loaded into the panel (guards file-browser
 *  sync from wiping loaded paths). Used to be a separate `classifier_display_name`
 *  signal, which we dropped because the field carried no info beyond what
 *  `classifier_path` already does — it was just the file basename, and
 *  shared the cleanup state-machine via empty-string sentinels. Now we ask
 *  the source of truth directly. */
export const hasClassifierLoaded = (content: ContentItem[]): boolean => {
  const v = getContentStringValue(content, "classifier_path");
  return v != null && v.trim() !== "";
};

/** UI label for a loaded classifier — just the basename of `classifier_path`.
 *  Returns null when no path is set. With the `classifier_display_name` field
 *  removed, this is the single source of truth for "what to show the user". */
export const getClassifierDisplayBasename = (content: ContentItem[]): string | null => {
  const p = getContentStringValue(content, "classifier_path");
  if (p == null) return null;
  const normalized = p.replace(/\\/g, "/").trim();
  if (!normalized) return null;
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
};

export const removeClassifierPathContent = (content: ContentItem[]): ContentItem[] =>
  content.filter(
    (item) =>
      item.key !== "classifier_path" &&
      item.key !== "save_classifier_path" &&
      item.key !== "classifier_download_link"
  );

export const upsertContentStringValue = (
  content: ContentItem[],
  key: string,
  value: string
): ContentItem[] => {
  const index = content.findIndex(item => item.key === key);
  if (index > -1) {
    return content.map((item, itemIndex) => itemIndex === index ? { ...item, value } : item);
  }
  return [...content, { key, type: "input", value }];
};
