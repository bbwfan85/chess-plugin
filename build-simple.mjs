import esbuild from "esbuild";

try {
  await esbuild.build({
    entryPoints: ["main.ts"],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
    ],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: false,
    treeShaking: true,
    outfile: "main.js",
  });
  console.log("✅ Build successful!");
} catch (error) {
  console.error("❌ Build failed:", error);
  process.exit(1);
}