import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

const getClassifierPathDisplayName = (path: string | null): string => {
  if (!path) return "";
  const pathWithoutExt = path.replace(/\.tlcls$/, "");
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = pathWithoutExt.split(separator);
  return parts[parts.length - 1] || pathWithoutExt;
};

/**
 * The classifier name shown in each pill. Double-click to edit it inline; on
 * commit the parent rewrites the corresponding request path (classifier_path /
 * save_classifier_path) — it does NOT rename the on-disk file. When no onCommit
 * is supplied the name is plain read-only text.
 */
const EditableName: React.FC<{
  value: string;
  fullPath?: string | null;
  className: string;
  onCommit?: (newName: string) => void;
}> = ({ value, fullPath, className, onCommit }) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!onCommit) {
    return (
      <span className={className} title={fullPath || undefined}>
        {value}
      </span>
    );
  }

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value) onCommit(next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className="min-w-0 flex-1 rounded-sm border border-primary/40 bg-background px-1 text-xs outline-none focus:border-primary"
      />
    );
  }

  return (
    <span
      className={`${className} cursor-text`}
      title={fullPath ? `${fullPath} (double-click to rename)` : "Double-click to rename"}
      onDoubleClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
};

export interface ClassifierStatusBannerProps {
  selectedModelForCurrentPath: string | null;
  updateClassifier: boolean;
  // Optional: actual paths that will be sent in the workflow payload
  // If provided, these will be displayed instead of just the filename
  actualClassifierPath?: string | null;
  actualSaveClassifierPath?: string | null;
  actualClassifierName?: string | null;
  /** When provided, render an X button on the "Selected Classifier" pill that calls this. */
  onClear?: () => void;
  /** When provided, render an X button on the "Updating Classifier" pill that calls this. */
  onClearSave?: () => void;
  /** When provided, double-clicking the "Selected Classifier" name lets the user
   *  rename it; the new basename is passed back (no extension, no directory). */
  onRename?: (newName: string) => void;
  /** Same as onRename, for the "Updating Classifier" (save target) pill. */
  onRenameSave?: (newName: string) => void;
}

export const ClassifierStatusBanner: React.FC<ClassifierStatusBannerProps> = ({
  selectedModelForCurrentPath,
  updateClassifier,
  actualClassifierPath,
  actualSaveClassifierPath,
  actualClassifierName,
  onClear,
  onClearSave,
  onRename,
  onRenameSave,
}) => {
  const hasGraphClassifierOverride = actualClassifierName != null;
  if (hasGraphClassifierOverride && actualClassifierName.trim() === "") {
    return null;
  }

  const displayLoadPath = hasGraphClassifierOverride
    ? actualClassifierPath ?? null
    : actualClassifierPath || selectedModelForCurrentPath;
  const displaySavePath = actualSaveClassifierPath || selectedModelForCurrentPath;
  // Always display the actual on-disk filename (basename of the path).
  // We don't fall back to a community title — the user prefers seeing the
  // real file name even when that's a UUID, since the title can diverge
  // from what's actually on disk after community upload + rename rounds.
  const displayLoadName = getClassifierPathDisplayName(displayLoadPath) || "";

  if (!displayLoadName) {
    return null;
  }

  return (
    <>
      {/* Selected classifier can come from graph load state or FileBrowser fallback. */}
      <div className="p-2 bg-primary/10 border border-primary/20 rounded-md text-xs">
        <div className="flex items-center gap-0.5">
          <span className="font-medium text-primary">Selected Classifier:</span>
          <EditableName
            value={displayLoadName}
            fullPath={displayLoadPath}
            className="text-primary/80 truncate flex-1"
            onCommit={onRename}
          />
          {onClear && (
            <button
              type="button"
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-primary/70 hover:bg-primary/20 hover:text-primary"
              onClick={onClear}
              title="Clear selected classifier"
              aria-label="Clear selected classifier"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Update Classifier Status */}
      {updateClassifier && displaySavePath && (
        <div className="p-2 bg-success/10 border border-success/20 rounded-md text-xs">
          <div className="flex items-center gap-0.5">
            <span className="font-medium text-success">Updating Classifier:</span>
            <EditableName
              value={getClassifierPathDisplayName(displaySavePath)}
              fullPath={displaySavePath}
              className="text-success/80 truncate flex-1"
              onCommit={onRenameSave}
            />
            {onClearSave && (
              <button
                type="button"
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-success/70 hover:bg-success/20 hover:text-success"
                onClick={onClearSave}
                title="Stop updating this classifier"
                aria-label="Stop updating this classifier"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
};
