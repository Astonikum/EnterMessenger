const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parsePreviews } = require("../previewParser");
const { buildPreview } = require("../previewCompiler");

async function main() {
  const buildFixture = async (relativePath, directive) => {
    const filePath = path.resolve("..", relativePath);
    const source = `${fs.readFileSync(filePath, "utf8")}\n${directive}\n`;
    const document = { uri: { fsPath: filePath }, getText: () => source };
    const preview = parsePreviews(source).previews[0];
    return buildPreview({ document, preview, workspaceRoot: path.resolve("..") });
  };

  const result = await buildFixture("src/main.tsx", '// #preview("Unsaved App") { <App /> }');

  assert.ok(result.javascript.length > 1000, "expected a bundled preview script");
  assert.ok(result.styles.length > 0, "expected CSS imported by the active document");
  assert.match(result.javascript, /createRoot/);

  const namedExport = await buildFixture(
    "src/components/ui/button.tsx",
    '// #preview Button {"children":"Continue"}'
  );
  assert.ok(namedExport.javascript.length > 1000, "expected named export preview bundle");

  const defaultExport = await buildFixture("src/App.tsx", "// #preview default {}");
  assert.ok(defaultExport.javascript.length > 1000, "expected default export preview bundle");

  const componentPreview = await buildFixture(
    "src/components/auth-page.tsx",
    '// #preview "Server check" AuthPage {}'
  );
  assert.ok(componentPreview.styles.length > 0, "expected app styles in a component preview");
  assert.match(componentPreview.styles, /\.flex\s*\{\s*display:\s*flex/, "expected Tailwind utilities in preview styles");
  assert.match(componentPreview.styles, /\.w-32\s*\{\s*width:\s*8rem/, "expected Tailwind sizing utilities in preview styles");
  assert.match(componentPreview.javascript, /data:image\/png;base64,/, "expected public image to be inlined");

  const modulePreview = await buildFixture(
    "src/components/ui/button.tsx",
    `/* #preview-module("Button gallery")
const demos = [
  <Button>Primary</Button>,
  <Button disabled>Disabled</Button>,
];
return <section>{demos}</section>;
*/`
  );
  assert.ok(modulePreview.javascript.length > 1000, "expected preview module bundle");
  assert.match(modulePreview.javascript, /Button gallery|Primary/);

  console.log("previewCompiler: ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
