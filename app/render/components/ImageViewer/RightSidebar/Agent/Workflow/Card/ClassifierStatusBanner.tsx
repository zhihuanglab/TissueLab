import React from "react";

const getClassifierPathDisplayName = (path: string | null): string => {
  if (!path) return "";
  const pathWithoutExt = path.replace(/\.tlcls$/, "");
  const separator = path.includes("\\") ? "\\" : "/";
  const parts = pathWithoutExt.split(separator);
  return parts[parts.length - 1] || pathWithoutExt;
};

export interface ClassifierStatusBannerProps {
  selectedModelForCurrentPath: string | null;
  updateClassifier: boolean;
  // Optional: actual paths that will be sent in the workflow payload
  // If provided, these will be displayed instead of just the filename
  actualClassifierPath?: string | null;
  actualSaveClassifierPath?: string | null;
  actualClassifierName?: string | null;
}

export const ClassifierStatusBanner: React.FC<ClassifierStatusBannerProps> = ({
  selectedModelForCurrentPath,
  updateClassifier,
  actualClassifierPath,
  actualSaveClassifierPath,
  actualClassifierName,
}) => {
  const hasGraphClassifierOverride = actualClassifierName != null;
  if (hasGraphClassifierOverride && actualClassifierName.trim() === "") {
    return null;
  }

  const displayLoadPath = hasGraphClassifierOverride
    ? actualClassifierPath ?? null
    : actualClassifierPath || selectedModelForCurrentPath;
  const displaySavePath = actualSaveClassifierPath || selectedModelForCurrentPath;
  const displayLoadName = actualClassifierName?.trim() || getClassifierPathDisplayName(displayLoadPath);

  if (!displayLoadName) {
    return null;
  }

  return (
    <>
      {/* Selected classifier can come from graph load state or FileBrowser fallback. */}
      <div className="p-2 bg-primary/10 border border-primary/20 rounded-md text-xs">
        <div className="flex items-center gap-0.5">
          <span className="font-medium text-primary">Selected Classifier:</span>
          <span className="text-primary/80 truncate" title={actualClassifierName || displayLoadPath || undefined}>
            {displayLoadName}
          </span>
        </div>
      </div>

      {/* Update Classifier Status */}
      {updateClassifier && displaySavePath && (
        <div className="p-2 bg-success/10 border border-success/20 rounded-md text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-success">Updating Classifier:</span>
            <span className="text-success/80 truncate" title={displaySavePath}>
              {getClassifierPathDisplayName(displaySavePath)}
            </span>
          </div>
        </div>
      )}
    </>
  );
};

