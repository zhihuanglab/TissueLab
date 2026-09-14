import coreWebVitals from "eslint-config-next/core-web-vitals";

/**
 * ESLint flat config (`next lint` was removed in Next.js 16; run `eslint .`).
 *
 * eslint-plugin-react-hooks 7 (pulled in by eslint-config-next 16) ships the
 * React Compiler lint rules as errors. They fire on long-standing patterns in
 * this codebase (refs assigned during render, setState inside effects, …), so
 * they are reported as warnings until the code is migrated.
 */
const config = [
  {
    ignores: [".next/**", "out/**", "node_modules/**", "next-env.d.ts", "setup-standalone.js"],
  },
  ...coreWebVitals,
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/purity": "warn",
    },
  },
];

export default config;
