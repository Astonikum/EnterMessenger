const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parsePreviews } = require("../previewParser");
const { buildPreview } = require("../previewCompiler");

function writeFixture(root) {
  const sourceDirectory = path.join(root, "src");
  const componentDirectory = path.join(sourceDirectory, "components");
  const styleDirectory = path.join(sourceDirectory, "styles");
  const publicDirectory = path.join(root, "public");
  const reactDirectory = path.join(root, "node_modules", "react");
  const reactDomDirectory = path.join(root, "node_modules", "react-dom");

  for (const directory of [componentDirectory, styleDirectory, publicDirectory, reactDirectory, reactDomDirectory]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fs.writeFileSync(path.join(root, "src", "main.tsx"), 'import "./app";\n');
  fs.writeFileSync(path.join(root, "src", "app.tsx"), 'import "./styles/global.css";\n');
  fs.writeFileSync(path.join(styleDirectory, "global.css"), ".app-shell { display: grid; }\n");
  fs.writeFileSync(path.join(publicDirectory, "logo.png"), Buffer.from("preview-image"));
  fs.writeFileSync(path.join(reactDirectory, "index.js"), `
exports.createElement = (type, props, ...children) => ({ type, props, children });
exports.Fragment = Symbol.for("react.fragment");
`);
  fs.writeFileSync(path.join(reactDomDirectory, "client.js"), `
exports.createRoot = () => ({ render() {} });
`);

  const componentPath = path.join(componentDirectory, "Button.tsx");
  fs.writeFileSync(componentPath, `
import * as React from "react";

const image = "/logo.png";
export function Button({ label, disabled }) {
  return <button disabled={disabled}><img src={image} />{label}</button>;
}

export default Button;
`);
  return componentPath;
}

async function main() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "react-preview-"));

  try {
    const componentPath = writeFixture(fixtureRoot);
    const buildFixture = async (directive) => {
      const source = `${fs.readFileSync(componentPath, "utf8")}\n${directive}\n`;
      const document = { uri: { fsPath: componentPath }, getText: () => source };
      const parsed = parsePreviews(source);
      assert.strictEqual(parsed.errors.length, 0);
      return buildPreview({ document, preview: parsed.previews[0], workspaceRoot: fixtureRoot });
    };

    const expressionPreview = await buildFixture('// #preview("JSX body") { <Button label="Continue" /> }');
    assert.ok(expressionPreview.javascript.length > 100, "expected a bundled preview script");
    assert.match(expressionPreview.javascript, /createRoot/);
    assert.match(expressionPreview.javascript, /data:image\/png;base64,/);
    assert.match(expressionPreview.styles, /\.app-shell\s*\{\s*display:\s*grid/);

    const namedExport = await buildFixture('// #preview Button {"label":"Continue"}');
    assert.match(namedExport.javascript, /Continue/);

    const defaultExport = await buildFixture("// #preview default {}");
    assert.match(defaultExport.javascript, /createRoot/);

    const modulePreview = await buildFixture(`/* #preview-module("Button gallery")
const demos = [
  <Button>Primary</Button>,
  <Button disabled>Disabled</Button>,
];
return <section>{demos}</section>;
*/`);
    assert.match(modulePreview.javascript, /Primary/);

    console.log("previewCompiler: ok");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
