const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

function getLanguageLoader(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === ".ts" || extension === ".tsx" ? "tsx" : "jsx";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createPreviewExportName(source, preview) {
  const base = `__reactPreview_${preview.start.toString(36)}`;
  let name = base;
  let suffix = 1;
  while (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source)) {
    name = `${base}_${suffix}`;
    suffix += 1;
  }
  return name;
}

function getPreviewSource(source, preview) {
  if (preview.kind === "module") {
    const exportName = createPreviewExportName(source, preview);
    return {
      source: `${source}\n\nexport const ${exportName} = () => {\n${preview.module}\n};\n`,
      exportName
    };
  }

  if (preview.kind !== "expression") {
    return source;
  }

  const exportName = createPreviewExportName(source, preview);
  return {
    source: `${source}\n\nexport const ${exportName} = () => (${preview.expression});\n`,
    exportName
  };
}

function getStyleEntries(workspaceRoot) {
  if (!workspaceRoot) {
    return [];
  }

  const candidates = [
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
    "main.tsx", "main.ts", "main.jsx", "main.js",
    "index.tsx", "index.ts", "index.jsx", "index.js"
  ];
  const entries = new Set();
  const importPattern = /(?:import|export)\s+(?:[^"'`]+?\sfrom\s+)?["']([^"'`]+\.css)["']/g;

  for (const candidate of candidates) {
    const entryPath = path.join(workspaceRoot, candidate);
    if (!fs.existsSync(entryPath)) {
      continue;
    }

    const source = fs.readFileSync(entryPath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      if (!match[1].startsWith(".")) {
        continue;
      }

      const stylePath = path.resolve(path.dirname(entryPath), match[1]);
      if (fs.existsSync(stylePath)) {
        entries.add(stylePath);
      }
    }
  }

  return [...entries];
}

function buildWrapper(filePath, preview, generatedExportName, styleEntries) {
  const importTarget = JSON.stringify(filePath);
  const componentExpression = preview.kind === "expression" || preview.kind === "module"
    ? `__module[${JSON.stringify(generatedExportName)}]`
    : preview.target === "default"
      ? "__module.default"
      : `__module[${JSON.stringify(preview.target)}]`;
  const props = preview.kind === "expression" ? "{}" : JSON.stringify(preview.props);

  return `
${styleEntries.map((stylePath) => `import ${JSON.stringify(stylePath)};`).join("\n")}
import * as React from "react";
import { createRoot } from "react-dom/client";
import * as __module from ${importTarget};

const __Component = ${componentExpression};
if (!__Component) {
  throw new Error(${JSON.stringify(
    preview.kind === "expression"
      ? "Preview expression did not produce a component"
      : `Экспорт «${preview.target}» не найден`
  )});
}

createRoot(document.getElementById("root")).render(
  React.createElement(__Component, ${props})
);
`;
}

function getPublicAssetData(publicDirectory, urlPath) {
  const match = /^\/([^?#]+)(?:[?#].*)?$/.exec(urlPath);
  if (!match) {
    return undefined;
  }

  const assetPath = path.resolve(publicDirectory, decodeURIComponent(match[1]));
  const relativePath = path.relative(publicDirectory, assetPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath) || !fs.existsSync(assetPath)) {
    return undefined;
  }

  const mimeTypes = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf"
  };
  const mimeType = mimeTypes[path.extname(assetPath).toLowerCase()];
  if (!mimeType) {
    return undefined;
  }

  return `data:${mimeType};base64,${fs.readFileSync(assetPath).toString("base64")}`;
}

function inlinePublicAssets(text, publicDirectory, css = false) {
  if (!publicDirectory || !fs.existsSync(publicDirectory)) {
    return text;
  }

  if (css) {
    return text.replace(/url\(\s*(["']?)(\/[^)'"\s]+)\1\s*\)/g, (match, quote, urlPath) => {
      const data = getPublicAssetData(publicDirectory, urlPath);
      return data ? `url(${quote}${data}${quote})` : match;
    });
  }

  return text.replace(/(["'`])\/(?:[^"'`]+)\1/g, (match, quote) => {
    const urlPath = match.slice(1, -1);
    const data = getPublicAssetData(publicDirectory, urlPath);
    return data ? `${quote}${data}${quote}` : match;
  });
}

function loadWorkspaceModule(name, workspaceRoot) {
  try {
    return require(require.resolve(name, { paths: [workspaceRoot, __dirname] }));
  } catch {
    return undefined;
  }
}

async function processProjectStyles(styles, workspaceRoot) {
  if (!workspaceRoot || !/@tailwind\b|@apply\b/.test(styles)) {
    return styles;
  }

  const postcss = loadWorkspaceModule("postcss", workspaceRoot);
  const tailwindcss = loadWorkspaceModule("tailwindcss", workspaceRoot);
  if (!postcss || !tailwindcss) {
    return styles;
  }

  const configName = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.mjs"]
    .find((name) => fs.existsSync(path.join(workspaceRoot, name)));
  const content = [
    path.join(workspaceRoot, "index.html"),
    path.join(workspaceRoot, "src/**/*.{js,jsx,ts,tsx}")
  ];
  let tailwindOptions = { content };
  if (configName) {
    try {
      tailwindOptions = { ...require(path.join(workspaceRoot, configName)), content };
    } catch {
      tailwindOptions = { content };
    }
  }
  const autoprefixer = loadWorkspaceModule("autoprefixer", workspaceRoot);
  const plugins = [tailwindcss(tailwindOptions)];
  if (autoprefixer) {
    plugins.push(autoprefixer);
  }

  return (await postcss(plugins).process(styles, {
    from: path.join(workspaceRoot, ".react-preview.css")
  })).css;
}

async function buildPreview({ document, preview, workspaceRoot }) {
  const filePath = document.uri.fsPath;
  const source = document.getText();
  const generated = getPreviewSource(source, preview);
  const generatedSource = typeof generated === "string" ? generated : generated.source;
  const generatedExportName = typeof generated === "string" ? undefined : generated.exportName;
  const styleEntries = getStyleEntries(workspaceRoot);
  const wrapper = buildWrapper(filePath, preview, generatedExportName, styleEntries);
  const sourcePath = path.join(path.dirname(filePath), `${path.basename(filePath)}.react-preview.tsx`);
  const outputDirectory = path.join(path.dirname(filePath), ".react-preview");
  const currentBuild = ++buildPreview.buildNumber;
  const result = await esbuild.build({
    absWorkingDir: workspaceRoot || path.dirname(filePath),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
    outdir: outputDirectory,
    logLevel: "silent",
    stdin: {
      contents: wrapper,
      loader: "tsx",
      resolveDir: path.dirname(filePath),
      sourcefile: sourcePath
    },
    loader: {
      ".avif": "dataurl",
      ".eot": "dataurl",
      ".gif": "dataurl",
      ".ico": "dataurl",
      ".jpeg": "dataurl",
      ".jpg": "dataurl",
      ".png": "dataurl",
      ".svg": "dataurl",
      ".ttf": "dataurl",
      ".webp": "dataurl",
      ".woff": "dataurl",
      ".woff2": "dataurl"
    },
    plugins: [
      {
        name: "react-preview-active-document",
        setup(build) {
          build.onLoad({ filter: /.*/ }, (args) => {
            if (path.resolve(args.path) !== path.resolve(filePath)) {
              return undefined;
            }

            return {
              contents: generatedSource,
              loader: getLanguageLoader(filePath),
              resolveDir: path.dirname(filePath)
            };
          });
        }
      }
    ]
  });

  if (currentBuild !== buildPreview.buildNumber) {
    return null;
  }

  const javascript = result.outputFiles.find((file) => file.path.endsWith(".js"))
    || result.outputFiles.find((file) => file.path === "<stdout>");
  const styles = result.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");
  const publicDirectory = workspaceRoot ? path.join(workspaceRoot, "public") : undefined;
  const processedStyles = await processProjectStyles(styles, workspaceRoot);

  return {
    javascript: javascript ? inlinePublicAssets(javascript.text, publicDirectory) : "",
    styles: inlinePublicAssets(processedStyles, publicDirectory, true)
  };
}

buildPreview.buildNumber = 0;

function stopPreviewCompiler() {
  return esbuild.stop();
}

module.exports = { buildPreview, stopPreviewCompiler };
