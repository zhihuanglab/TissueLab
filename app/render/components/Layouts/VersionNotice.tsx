import React, { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";

/**
 * Source of truth for the latest released TissueLab version. Served by the
 * tissuelab.org Next.js app (`/api/version` -> `{ version: string }`); returns
 * `"NA"` when the site hasn't been told about a version yet.
 */
const VERSION_API_URL = "https://tissuelab.org/api/version";

/** Version baked into this build (from render/package.json, see next.config.js). */
const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

/** localStorage key; value is the latest version the user last dismissed. */
const DISMISS_KEY = "tissuelab:version-notice-dismissed";

function isElectronEnv(): boolean {
  return typeof window !== "undefined" && !!(window as any).electron;
}

/**
 * Dismissible banner pinned to the bottom of the screen, shown the first time
 * the app is opened on a build that's older than the latest released version
 * (per `tissuelab.org/api/version`). Works in both the web build and the
 * Electron app; dismissal is remembered per-version so it only nags once until
 * a newer version ships. If the version check fails or the site reports "NA",
 * nothing is shown.
 */
export default function VersionNotice() {
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(VERSION_API_URL, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const latest = typeof data?.version === "string" ? data.version.trim() : "";
        if (cancelled) return;
        // Unknown, same as current, or no current version to compare against -> skip.
        if (!latest || latest === "NA" || !CURRENT_VERSION || latest === CURRENT_VERSION) return;
        let dismissed: string | null = null;
        try {
          dismissed = window.localStorage.getItem(DISMISS_KEY);
        } catch {
          /* localStorage unavailable */
        }
        if (dismissed === latest) return;
        setLatestVersion(latest);
      } catch {
        /* network error -> no banner */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!latestVersion) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, latestVersion);
    } catch {
      /* ignore */
    }
    setLatestVersion(null);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center gap-3 border-t border-amber-300 bg-amber-50/95 px-4 py-3 shadow-lg backdrop-blur-md sm:px-6">
      <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-500" aria-hidden="true" />
      <p className="flex-1 text-sm leading-relaxed text-amber-800">
        {isElectronEnv() ? (
          <>
            The web version of TissueLab is more up to date than this desktop app
            {CURRENT_VERSION ? ` (you're on ${CURRENT_VERSION})` : ""}. An updated desktop app
            is coming soon; for the latest features, use the{" "}
            <a
              href="https://app.tissuelab.org"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-amber-900"
            >
              TissueLab web portal
            </a>
            .
          </>
        ) : (
          <>An updated app is still on the way. For the latest features, please use the current web version.</>
        )}
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="flex-shrink-0 rounded-md p-1 text-amber-600 transition-colors hover:bg-amber-100 hover:text-amber-800"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}
