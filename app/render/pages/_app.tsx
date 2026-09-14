import "@/styles/globals.css";

import type { NextPage } from "next";
import type { AppProps } from "next/app";
import { Inter } from "next/font/google";
import Head from "next/head";
import React, { useEffect, type ReactElement } from "react";
import { Provider } from "react-redux";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Toaster } from "sonner";

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
