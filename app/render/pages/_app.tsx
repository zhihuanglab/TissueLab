import "@/styles/globals.css";
import '@coreui/coreui/dist/css/coreui.min.css';
import type { AppProps } from "next/app";
import type { NextPage } from 'next';
import type { ReactElement } from 'react';
import Head from "next/head";
import Script from "next/script";
import { Provider, useSelector } from "react-redux";
// Removed PersistGate - following tissuelab.org lightweight approach
import { store, RootState } from "@/store";
import React, { useEffect } from "react";
import { Outfit } from "next/font/google";
import AppSidebar from "@/components/Layouts/AppSidebar";
import AppHeader from "@/components/Layouts/AppHeader";
import { AnnotatorProvider } from "@/contexts/AnnotatorContext";
import { UserInfoProvider } from "@/provider/UserInfoProvider";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Toaster } from "sonner";
//import "@/utils/setWebGLPreserveDrawingBufferHook"; // Import to activate WebGL hook


const outfit = Outfit({ subsets: ["latin"] });

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

  return (
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
            {/*@ts-ignore*/}
            {getLayout(<Component {...pageProps} />)}
            <Toaster position="bottom-right" toastOptions={{style: { insetInlineEnd: 10 } }} />
            
          </AnnotatorProvider>
        </UserInfoProvider>
      </Provider>
    </GoogleOAuthProvider>
  );
}

function MainLayout({ children }: { children: React.ReactNode }) {
  const sidebarShow = useSelector((state: RootState) => state.sidebar.sidebarShow);
  const unfoldable = useSelector((state: RootState) => state.sidebar.unfoldable);

  return (
    <div className="app-container flex">
      <AppSidebar />
      <div
        className={`main-content-wrapper flex flex-col h-screen flex-grow transition-all duration-300 ${
          sidebarShow ? (unfoldable ? 'w-[calc(100%-64px)]' : 'w-[calc(100%-240px)]') : 'w-full'
        }`}
      >
        <AppHeader />
        <main className="main-content flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

export default App;
