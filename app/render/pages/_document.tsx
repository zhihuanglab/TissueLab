import { Head, Html, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en" className="font-sans">
      <Head>
        <link rel="icon" href="/TissueLab_logo.ico" sizes="any" />
        <link rel="apple-touch-icon" href="/brand/TissueLab_logo.png" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
