const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");
const { parsePreviews } = require("./previewParser");
const { buildPreview, stopPreviewCompiler } = require("./previewCompiler");

const REACT_LANGUAGES = new Set(["javascriptreact", "typescriptreact"]);
let previewPanel;
let activePreview;
let diagnostics;
let codeLensProvider;

function isReactDocument(document) {
  return Boolean(document && REACT_LANGUAGES.has(document.languageId));
}

function getPreviewData(document) {
  return parsePreviews(document.getText());
}

function createCodeLensProvider() {
  const changeEmitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeCodeLenses: changeEmitter.event,
    provideCodeLenses(document) {
      if (!isReactDocument(document)) {
        return [];
      }

      return getPreviewData(document).previews.map((preview) => {
        const range = new vscode.Range(
          document.positionAt(preview.start),
          document.positionAt(preview.end)
        );
        return new vscode.CodeLens(range, {
          title: `$(open-preview) Preview: ${preview.label}`,
          command: "reactPreview.open",
          arguments: [document.uri, preview.id]
        });
      });
    },
    refresh() {
      changeEmitter.fire();
    },
    dispose() {
      changeEmitter.dispose();
    }
  };

  return provider;
}

function updateDiagnostics(document) {
  if (!diagnostics) {
    return;
  }

  if (!isReactDocument(document)) {
    diagnostics.delete(document.uri);
    return;
  }

  const entries = getPreviewData(document).errors.map((error) => {
    const end = Math.max(error.end, error.start + 1);
    const range = new vscode.Range(document.positionAt(error.start), document.positionAt(end));
    return new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error);
  });
  diagnostics.set(document.uri, entries);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function getBaseStyles() {
  return `
    html, body { min-height: 100%; margin: 0; }
    body {
      padding: 16px;
      box-sizing: border-box;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
    }
    .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .toolbar button { border: 0; border-radius: 4px; padding: 5px 10px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    .toolbar small { color: var(--vscode-descriptionForeground); }
    #root { min-height: 24px; }
    .error { white-space: pre-wrap; color: var(--vscode-errorForeground); }
  `;
}

function getLoadingHtml() {
  return `<!doctype html><html><body style="padding:24px;font-family:var(--vscode-font-family)">Собираем превью…</body></html>`;
}

function getReloadScript(nonce) {
  return `<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelector('[data-action="reload"]')?.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  </script>`;
}

function getPreviewSecurityScript() {
  return `
    function previewBlockedError(api) {
      const error = new Error(api + " is disabled in React Preview");
      error.reactPreviewBlocked = true;
      return error;
    }
    function blockPreviewRequest(api) {
      console.warn("React Preview blocked " + api);
      return Promise.reject(previewBlockedError(api));
    }
    window.fetch = () => blockPreviewRequest("fetch");
    window.XMLHttpRequest = class PreviewBlockedXMLHttpRequest {
      open() { throw previewBlockedError("XMLHttpRequest"); }
      send() { throw previewBlockedError("XMLHttpRequest"); }
      setRequestHeader() { throw previewBlockedError("XMLHttpRequest"); }
    };
    window.WebSocket = class PreviewBlockedWebSocket {
      constructor() { throw previewBlockedError("WebSocket"); }
    };
    window.EventSource = class PreviewBlockedEventSource {
      constructor() { throw previewBlockedError("EventSource"); }
    };
    window.open = () => null;
    try {
      Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: () => blockPreviewRequest("clipboard.readText"),
          writeText: () => blockPreviewRequest("clipboard.writeText")
        }
      });
    } catch {}
    const previewStorage = {
      length: 0,
      clear() {},
      getItem() { return null; },
      key() { return null; },
      removeItem() {},
      setItem() {}
    };
    try {
      Object.defineProperty(window, "localStorage", { configurable: true, value: previewStorage });
      Object.defineProperty(window, "sessionStorage", { configurable: true, value: previewStorage });
    } catch {}
  `;
}

function getWebviewHtml(content) {
  const nonce = getNonce();
  const script = content.javascript.replace(/<\/script/gi, "<\\/script");
  const styles = content.styles.replace(/<\/style/gi, "<\\/style");
  const runtimeScript = `
    function showRuntimeError(error) {
      if (error?.reactPreviewBlocked) {
        return;
      }
      const root = document.getElementById("root");
      root.innerHTML = "<pre class=\\"error\\"></pre>";
      root.querySelector("pre").textContent = error?.stack || error?.message || String(error);
    }
    window.addEventListener("error", (event) => showRuntimeError(event.error || event.message));
    window.addEventListener("unhandledrejection", (event) => {
      if (event.reason?.reactPreviewBlocked) {
        event.preventDefault();
        return;
      }
      showRuntimeError(event.reason);
    });
  `;

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; navigate-to 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; script-src 'nonce-${nonce}';" />
    <style>${getBaseStyles()}${styles}</style>
  </head>
  <body>
    <div class="toolbar">
      <button type="button" data-action="reload">Reload</button>
      <small>React Preview · network disabled</small>
    </div>
    <div id="root"></div>
    <script nonce="${nonce}">${runtimeScript}${getPreviewSecurityScript()}${script}</script>
    ${getReloadScript(nonce)}
  </body>
</html>`;
}

function getBuildErrorMessage(error) {
  if (error && error.errors) {
    return error.errors.map((item) => {
      const location = item.location;
      const prefix = location?.file && location.line
        ? `${location.file}:${location.line}:${location.column || 1}: `
        : "";
      return `${prefix}${item.text}`;
    }).join("\n");
  }
  return error?.message || String(error);
}

function getErrorHtml(message) {
  const nonce = getNonce();
  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <style>${getBaseStyles()}</style>
  </head>
  <body>
    <div class="toolbar"><button type="button" data-action="reload">Reload</button><small>React Preview: ошибка сборки</small></div>
    <pre class="error">${escapeHtml(message)}</pre>
    ${getReloadScript(nonce)}
  </body>
</html>`;
}

function showBuildError(error) {
  if (previewPanel) {
    previewPanel.webview.html = getErrorHtml(getBuildErrorMessage(error));
  }
}

async function refreshPreview() {
  if (!previewPanel || !activePreview?.preview) {
    return;
  }

  const panel = previewPanel;
  const requestedPreview = activePreview;
  panel.webview.html = getLoadingHtml();

  try {
    const content = await buildPreview({
      document: requestedPreview.document,
      preview: requestedPreview.preview,
      workspaceRoot: vscode.workspace.getWorkspaceFolder(requestedPreview.document.uri)?.uri.fsPath
    });

    if (content && panel === previewPanel && requestedPreview === activePreview) {
      panel.webview.html = getWebviewHtml(content);
    }
  } catch (error) {
    if (panel === previewPanel && requestedPreview === activePreview) {
      showBuildError(error);
    }
  }
}

async function choosePreview(previews, previewId) {
  if (previewId !== undefined && previewId !== null) {
    return previews.find((preview) => preview.id === String(previewId))
      || previews.find((preview) => preview.index === Number(previewId));
  }

  if (previews.length === 1) {
    return previews[0];
  }

  const choice = await vscode.window.showQuickPick(
    previews.map((preview) => ({
      label: preview.label,
      description: preview.kind === "expression"
        ? "JSX body"
        : preview.kind === "module"
          ? "Preview module"
          : `${preview.target} + props`,
      preview
    })),
    { placeHolder: "Выберите React Preview" }
  );
  return choice?.preview;
}

async function openPreview(uri, previewId) {
  const document = uri
    ? await vscode.workspace.openTextDocument(uri)
    : vscode.window.activeTextEditor?.document;

  if (!isReactDocument(document)) {
    vscode.window.showInformationMessage("Откройте JSX или TSX-файл с директивой #preview.");
    return;
  }

  const { previews } = getPreviewData(document);
  const selected = await choosePreview(previews, previewId);
  if (!selected) {
    vscode.window.showInformationMessage("Превью не найдены. Добавьте // #preview Button {}.");
    return;
  }

  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel(
      "reactPreview",
      `Preview: ${selected.label}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    previewPanel.webview.onDidReceiveMessage((message) => {
      if (message?.type === "reload") {
        refreshPreview();
      }
    });
    previewPanel.onDidDispose(() => {
      previewPanel = undefined;
      activePreview = undefined;
    });
  } else {
    previewPanel.reveal(vscode.ViewColumn.Beside);
  }

  previewPanel.title = `Preview: ${selected.label}`;
  activePreview = { document, preview: selected };
  await refreshPreview();
}

function refreshActivePreviewAfterSave(document) {
  if (!activePreview || activePreview.document.uri.toString() !== document.uri.toString()) {
    return;
  }

  const { previews } = getPreviewData(document);
  const preview = previews.find((item) => item.id === activePreview.preview?.id) || previews[0];
  if (!preview) {
    activePreview = { document, preview: undefined };
    showBuildError(new Error("В исходном файле больше нет валидных #preview-директив."));
    return;
  }

  activePreview = { document, preview };
  refreshPreview();
}

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("react-preview");
  codeLensProvider = createCodeLensProvider();

  context.subscriptions.push(
    diagnostics,
    codeLensProvider,
    vscode.languages.registerCodeLensProvider(
      [{ language: "javascriptreact" }, { language: "typescriptreact" }],
      codeLensProvider
    ),
    vscode.commands.registerCommand("reactPreview.open", openPreview),
    vscode.commands.registerCommand("reactPreview.refresh", refreshPreview),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (isReactDocument(document)) {
        updateDiagnostics(document);
        codeLensProvider.refresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      updateDiagnostics(document);
      if (
        vscode.workspace.getConfiguration("reactPreview").get("refreshOnSave", true) &&
        isReactDocument(document)
      ) {
        refreshActivePreviewAfterSave(document);
      }
    })
  );

  vscode.workspace.textDocuments.forEach(updateDiagnostics);
}

function deactivate() {
  return stopPreviewCompiler();
}

module.exports = { activate, deactivate, getPreviewSecurityScript, getWebviewHtml };
