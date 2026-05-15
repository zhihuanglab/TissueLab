import "@/styles/globals.css";
// import '@coreui/coreui/dist/css/coreui.min.css';
import type { NextPage } from 'next';
import type { AppProps } from "next/app";
import Head from "next/head";
import type { ReactElement } from 'react';
import { Provider } from "react-redux";
// Removed PersistGate - following tissuelab.org lightweight approach
import AppHeader from "@/components/layouts/AppHeader";
import AppSidebar from "@/components/layouts/AppSidebar";
import VersionNotice from "@/components/layouts/VersionNotice";
import { AnnotatorProvider } from "@/contexts/AnnotatorContext";
import { ThemeProvider } from "@/provider/theme/ThemeProvider";
import { UserInfoProvider } from "@/provider/UserInfoProvider";
import { store } from "@/store";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Inter } from "next/font/google";
import React, { useEffect } from "react";
import { Toaster } from "sonner";


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
                {/*@ts-ignore*/}
                {getLayout(<Component {...pageProps} />)}
                <VersionNotice />
                <Toaster position="bottom-left" toastOptions={{ style: { insetInlineStart: 2, insetBlockEnd: 2 } }} />
              </ThemeProvider>
            </AnnotatorProvider>
          </UserInfoProvider>
        </Provider>
      </GoogleOAuthProvider>
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
