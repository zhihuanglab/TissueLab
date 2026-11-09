import "@/styles/globals.css";

import type { NextPage } from "next";
import type { AppProps } from "next/app";
import { Inter } from "next/font/google";
import Head from "next/head";
import React, { useEffect, type ReactElement } from "react";
import { Provider } from "react-redux";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Toaster, toast } from "sonner";

import { PreRunProgressWidget } from "@/components/dashboard/PreRunProgressWidget";
import ErrorBoundary from "@/components/imageViewer/review/ErrorBoundary";
import AppHeader from "@/components/layouts/AppHeader";
import AppSidebar from "@/components/layouts/AppSidebar";
import { AnnotatorProvider } from "@/contexts/AnnotatorContext";
import { ThemeProvider } from "@/contexts/theme/ThemeProvider";
import { UserInfoProvider } from "@/contexts/UserInfoProvider";
import { store } from "@/store";


const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Add these type definitions
type NextPageWithLayout = NextPage & {
  getLayout?: (page: ReactElement) => ReactElement;
};

type AppPropsWithLayout = AppProps & {
  Component: NextPageWithLayout;
};

function App({ Component, pageProps }: AppPropsWithLayout) {
  // Use getLayout if it exists, otherwise use default MainLayout
  const getLayout = Component.getLayout ?? ((page) => (
    <MainLayout>{page}</MainLayout>
  ));

  // Apply font variable to document.documentElement so Portal-rendered components can access it
  useEffect(() => {
    document.documentElement.classList.add(inter.variable);
    // Batch restore runs once auth uid is ready (UserInfoProvider), not on bare mount.
  }, []);

  // Electron main forwards its own faults (uncaught errors, the backend being
  // given up on after repeated crashes) on 'main-process-error'; show them.
  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.electron : undefined;
    if (!bridge?.on) return;
    const onMainProcessError = (payload?: { kind?: string; message?: string }) => {
      const kind = payload?.kind || "Application error";
      // Uncaught errors arrive with their stack; the first line is enough here.
      const firstLine = String(payload?.message ?? "").split("\n")[0].trim();
      const backendStopped = /backend/i.test(kind);
      // The only way back from a stopped backend is a restart: offer it here.
      const canRelaunch = backendStopped && typeof bridge.invoke === "function";
      toast.error(backendStopped ? "Backend service stopped" : `Background error: ${kind}`, {
        id: `main-process-error:${kind}`,
        description: firstLine || undefined,
        duration: backendStopped ? Infinity : 10000,
        ...(canRelaunch
          ? {
              action: {
                label: "Restart TissueLab",
                onClick: () => {
                  Promise.resolve(bridge.invoke!("relaunch-app")).catch(() => { /* older main */ });
                },
              },
            }
          : {}),
      });
    };
    bridge.on("main-process-error", onMainProcessError);
    // A notice raised while no window was open (macOS: window closed, app in
    // the Dock) is held by main until this listener exists; fetch it now.
    if (typeof bridge.invoke === "function") {
      Promise.resolve(bridge.invoke("take-pending-backend-notice"))
        .then((notice: unknown) => {
          if (typeof notice === "string" && notice) onMainProcessError({ kind: "Backend stopped", message: notice });
        })
        .catch(() => { /* older main without the handler */ });
    }
    return () => {
      try { bridge.off?.("main-process-error", onMainProcessError); } catch { /* bridge gone */ }
    };
  }, []);

  return (
    <div>
      <GoogleOAuthProvider clientId={process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ''}>
        <Provider store={store}>
          {/* Removed PersistGate - following tissuelab.org pattern */}
          <UserInfoProvider>
            <AnnotatorProvider>
              <Head>
                <title>TissueLab</title>
              </Head>
              {/* DISABLED: Google Identity Services script for One-Tap */}
              {/* <Script
                src="https://accounts.google.com/gsi/client"
                strategy="lazyOnload"
                onLoad={() => console.log('Google Identity Services script loaded')}
              /> */}
              <ThemeProvider>
                {/* Top-level boundary so render crashes on ANY page are caught
                    here (before Next's own boundary) and reported. */}
                <ErrorBoundary name="app-root" fallback={<AppCrashFallback />}>
                  {/*@ts-ignore*/}
                  {getLayout(<Component {...pageProps} />)}
                </ErrorBoundary>
                <PreRunProgressWidget />
                <Toaster position="bottom-left" toastOptions={{ style: { insetInlineStart: 2, insetBlockEnd: 2 } }} />
              </ThemeProvider>
            </AnnotatorProvider>
          </UserInfoProvider>
        </Provider>
      </GoogleOAuthProvider>
    </div>
  );
}

function AppCrashFallback() {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Something went wrong</h1>
      <p className="max-w-md text-sm text-gray-500 dark:text-gray-400">
        The page hit an unexpected error. Please reload to continue.
      </p>
      <button
        onClick={() => window.location.reload()}
        className="rounded-lg bg-[#6352A2] px-4 py-2 text-sm font-medium text-white hover:brightness-110"
      >
        Reload
      </button>
    </div>
  );
}

function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-container flex w-full overflow-hidden bg-background transition-all duration-100">
      <AppSidebar />
      <div className="main-content-wrapper flex h-screen flex-1 min-w-0 flex-col bg-background px-0">
        <AppHeader />
        <main className="main-content flex-1 overflow-auto bg-background">
          {children}
        </main>
      </div>
    </div>
  );
}

export default App;
