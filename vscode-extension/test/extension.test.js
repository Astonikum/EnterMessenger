const assert = require("assert");
const Module = require("module");

class EventEmitter {
  constructor() {
    this.event = () => ({ dispose() {} });
  }

  fire() {}

  dispose() {}
}

const registeredCommands = new Map();
let registeredProvider;
const vscode = {
  EventEmitter,
  Range: class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  },
  CodeLens: class CodeLens {
    constructor(range, command) {
      this.range = range;
      this.command = command;
    }
  },
  Diagnostic: class Diagnostic {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticSeverity: { Error: 0 },
  languages: {
    createDiagnosticCollection: () => ({
      delete() {},
      set() {},
      dispose() {}
    }),
    registerCodeLensProvider: (_, provider) => {
      registeredProvider = provider;
      return { dispose() {} };
    }
  },
  commands: {
    registerCommand: (name, callback) => {
      registeredCommands.set(name, callback);
      return { dispose() {} };
    }
  },
  workspace: {
    textDocuments: [],
    onDidChangeTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    getConfiguration: () => ({ get: (_, fallback) => fallback })
  },
  window: {}
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require("../extension");
  const context = { subscriptions: [] };
  extension.activate(context);

  assert.ok(registeredCommands.has("reactPreview.open"));
  assert.ok(registeredCommands.has("reactPreview.refresh"));
  assert.ok(registeredProvider);

  const previewHtml = extension.getWebviewHtml({ javascript: "", styles: "" });
  assert.match(previewHtml, /connect-src 'none'/);
  assert.match(previewHtml, /img-src data:/);
  assert.match(previewHtml, /network disabled/);
  assert.match(extension.getPreviewSecurityScript(), /window\.fetch/);
  assert.match(extension.getPreviewSecurityScript(), /window\.WebSocket/);

  const document = {
    languageId: "typescriptreact",
    uri: { toString: () => "file:///Preview.tsx" },
    getText: () => '// #preview Button {"label":"Test"}',
    positionAt: (offset) => ({ offset })
  };
  const lenses = registeredProvider.provideCodeLenses(document);
  assert.strictEqual(lenses.length, 1);
  assert.strictEqual(lenses[0].command.command, "reactPreview.open");

  console.log("extension: ok");
} finally {
  Module._load = originalLoad;
}
