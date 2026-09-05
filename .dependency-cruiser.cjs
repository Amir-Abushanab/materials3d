/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make module initialization and refactoring brittle.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolved",
      severity: "error",
      comment: "Every import must resolve to a file or installed package.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-dependencies",
      severity: "error",
      comment: "Runtime imports must be declared in the owning package's package.json.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "core-does-not-depend-on-app",
      severity: "error",
      comment:
        "The reusable @materials3d/core package must never reach into the studio application.",
      from: { path: "^packages/core/" },
      to: { path: "^apps/" },
    },
    {
      name: "interaction-runtime-stays-lazy",
      severity: "error",
      comment:
        "The interactivity runtime (controller + applier tables + tilt sensor, ~3.7 KB gzipped) must " +
        "be reachable ONLY through the dynamic import in each renderer's loadInteraction(). A static " +
        "import folds it into every bundle, including the scenes that never bind anything. Need one " +
        "of its config predicates synchronously? Those live in interactionGates.ts.",
      from: { pathNot: "^packages/core/src/renderer/interaction\\.ts$" },
      to: {
        path: "^packages/core/src/renderer/interaction\\.ts$",
        // `type-only` is `import type {...}`; `type-import` is `typeof import(...)`. Both are
        // erased at build time, so neither pulls the chunk in — only a value import does.
        dependencyTypesNot: ["dynamic-import", "type-only", "type-import"],
      },
    },
    {
      name: "renderer-stays-below-shell",
      severity: "error",
      comment:
        "The renderer is the lowest layer: it must not import the shell or the package index. " +
        "That layering is what keeps three.js out of the shell's initial chunk.",
      from: { path: "^packages/core/src/renderer/" },
      to: { path: "^packages/core/src/(?:index\\.ts$|shell/)" },
    },
    {
      name: "shell-never-statically-imports-three",
      severity: "error",
      comment:
        "The poster shell must reach the renderer (and three) only through the dynamic " +
        "import in core-loader, or the code-split falls apart and every consumer ships three.",
      from: { path: "^packages/core/src/shell/" },
      // Type-only imports are erased at build time, so they cost nothing and are allowed.
      to: {
        path: "^(?:three|packages/core/src/renderer/)",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "scripts-read-built-output",
      severity: "error",
      comment:
        "Tooling under scripts/ runs on plain node against the BUILT packages (dist and the " +
        "standalone bundle). Importing package sources would need a TypeScript loader and would " +
        "exercise code that is not what ships.",
      from: { path: "^scripts/" },
      to: { path: "^packages/[^/]+/src/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // Cruise the sources only: not the build output (which duplicates every module), not tests,
    // and not build configs. Those import root devDependencies (tsdown, vite) by design, which
    // no-undeclared-dependencies would otherwise flag.
    exclude: { path: "(?:/dist/|(?:\\.(?:test|spec)\\.[cm]?[jt]sx?|\\.config\\.[cm]?[jt]s)$)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
