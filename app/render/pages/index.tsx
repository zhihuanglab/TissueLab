"use client";

import { useEffect } from "react";
import { useRouter } from "next/router";
import { Loader2 } from "lucide-react";

/** Landing route: the open edition has no sign-in flow, so go straight to the dashboard. */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    router.replace("/dashboard");
  }, [router, router.isReady]);

  return (
    <div className="min-h-[calc(100vh-50px)] flex flex-col items-center justify-center bg-background">
      <div id="loading" aria-label="Loading..." role="status" className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Loading…</span>
      </div>
    </div>
  );
}
