import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Installed language modules point MYHARNESS_CODE_INTELLIGENCE_ROOT at their
// own small directory. The legacy private bundle used a runtime/ directory;
// accepting both layouts keeps old local builds readable while the source
// repository no longer needs to carry that bundle.
const configuredRoot = process.env.MYHARNESS_CODE_INTELLIGENCE_ROOT
  ? path.resolve(process.env.MYHARNESS_CODE_INTELLIGENCE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = existsSync(path.join(configuredRoot, "runtime")) ? path.join(configuredRoot, "runtime") : configuredRoot;
const pluginRoot = path.dirname(runtimeRoot);
const nodeModulesRoot = path.join(runtimeRoot, "node_modules");
const serversRoot = path.join(runtimeRoot, "servers");
const sharedRoots = (process.env.MYHARNESS_CODE_INTELLIGENCE_SHARED_ROOTS || "")
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => path.resolve(value));
const sharedNodeModulesRoots = sharedRoots.map((root) => path.join(root, "node_modules"));
const sharedServersRoots = sharedRoots.map((root) => path.join(root, "servers"));
const nodeModulesRoots = [nodeModulesRoot, ...sharedNodeModulesRoots];
const dataRoot = process.env.MYHARNESS_SYMBOLS_DATA_ROOT || path.join(pluginRoot, "data");
const key = process.argv[2];

function fail(message, code = 17) {
  process.stderr.write(`[myharness-symbols] ${message}\n`);
  process.exit(code);
}

function existingFile(filePath, label) {
  if (!existsSync(filePath)) fail(`${label} is not bundled: ${filePath}`);
  try {
    if (!statSync(filePath).isFile()) fail(`${label} is not a file: ${filePath}`);
  } catch (error) {
    fail(`${label} is not accessible: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  return filePath;
}

function packageRoot(packageName) {
  for (const modulesRoot of nodeModulesRoots) {
    const packagePath = path.join(modulesRoot, ...packageName.split("/"));
    if (existsSync(path.join(packagePath, "package.json"))) return packagePath;
  }
  const packagePath = path.join(nodeModulesRoot, ...packageName.split("/"));
  existingFile(path.join(packagePath, "package.json"), `private npm package ${packageName}`);
  return packagePath;
}

function nodeModuleFile(...parts) {
  const candidates = nodeModulesRoots.map((root) => path.join(root, ...parts));
  return existingFile(candidates.find((candidate) => existsSync(candidate)) || candidates[0], `private npm file ${parts.join("/")}`);
}

function packageBin(packageName, explicitBin) {
  const root = packageRoot(packageName);
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const rawBin = explicitBin ? (typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[explicitBin] || explicitBin) : manifest.bin;
  const bin = typeof rawBin === "string" ? rawBin : rawBin && typeof rawBin === "object" ? Object.values(rawBin)[0] : undefined;
  if (typeof bin !== "string" || !bin.trim()) fail(`private npm package ${packageName} does not declare a usable bin`);
  return existingFile(path.resolve(root, bin), `${packageName} launcher`);
}

function privatePath(...parts) {
  const candidates = [path.join(serversRoot, ...parts), ...sharedServersRoots.map((root) => path.join(root, ...parts))];
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function hashWorkspace(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function javaPath() {
  return existingFile(privatePath("jre", "bin", "java.exe"), "private Java runtime");
}

function firstMatching(directory, pattern) {
  if (!existsSync(directory)) fail(`private server directory is missing: ${directory}`);
  const match = readdirSync(directory).find((name) => pattern.test(name));
  if (!match) fail(`no file matching ${pattern} in ${directory}`);
  return path.join(directory, match);
}

function specFor(name) {
  const node = process.execPath;
  switch (name) {
    case "typescript-language-server":
      return { command: node, args: [packageBin("typescript-language-server"), "--stdio"], env: {} };
    case "pyright":
      return { command: node, args: [packageBin("pyright", "pyright-langserver"), "--stdio"], env: {} };
    case "vscode-json":
      return { command: node, args: [packageBin("vscode-langservers-extracted", "vscode-json-language-server"), "--stdio"], env: {} };
    case "vscode-css":
      return { command: node, args: [packageBin("vscode-langservers-extracted", "vscode-css-language-server"), "--stdio"], env: {} };
    case "bash-language-server":
      return { command: node, args: [packageBin("bash-language-server", "bash-language-server"), "start"], env: {} };
    case "svelte-language-server":
      return { command: node, args: [packageBin("svelte-language-server", "svelteserver"), "--stdio"], env: {} };
    case "vue-language-server":
      return { command: node, args: [packageBin("@vue/language-server", "vue-language-server"), "--stdio"], env: {} };
    case "yaml-language-server":
      return { command: node, args: [packageBin("yaml-language-server", "yaml-language-server"), "--stdio"], env: {} };
    case "devsense-php-ls":
      return { command: node, args: [packageBin("devsense-php-ls", "devsense-php-ls"), "--stdio"], env: {} };
    case "sqllens-language-server":
      return { command: node, args: [packageBin("sqllens-language-server", "sqllens-language-server"), "--stdio"], env: {} };
    case "clangd":
      return { command: existingFile(privatePath("clangd", "clangd.exe"), "private clangd"), args: [], env: {} };
    case "rust-analyzer":
      return {
        command: existingFile(privatePath("rust-analyzer", "rust-analyzer.exe"), "private rust-analyzer"),
        args: [],
        env: privateRustEnvironment(),
      };
    case "gopls":
      return {
        command: existingFile(privatePath("go-1.27.1", "gopls.exe"), "private gopls"),
        args: ["serve"],
        env: privateGoEnvironment(),
      };
    case "csharp-ls":
      {
        const dotnetRoot = privatePath("dotnet-10-sdk");
        const application = existingFile(privatePath("csharp-ls", "csharp-ls.exe"), "private csharp-ls");
        return {
          command: application,
          args: [],
          env: {
            DOTNET_ROOT: dotnetRoot,
            DOTNET_ROOT_X64: dotnetRoot,
            DOTNET_MULTILEVEL_LOOKUP: "0",
            DOTNET_CLI_HOME: path.join(dataRoot, "dotnet-home"),
            NUGET_PACKAGES: path.join(dataRoot, "nuget-packages"),
            DOTNET_CLI_TELEMETRY_OPTOUT: "1",
            DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
            PATH: [dotnetRoot, process.env.PATH || ""].join(path.delimiter),
          },
        };
      }
    case "kotlin-language-server": {
      const launcher = existingFile(privatePath("kotlin", "server", "bin", "kotlin-language-server.bat"), "private Kotlin language server");
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", "call", launcher],
        env: {
          JAVA_HOME: privatePath("jre"),
          MAVEN_REPOSITORY: privatePath("kotlin", "m2"),
        },
      };
    }
    case "solargraph": {
      const ruby = existingFile(privatePath("ruby", "bin", "ruby.exe"), "private Ruby runtime");
      const script = existingFile(privatePath("ruby", "bin", "solargraph"), "private Solargraph launcher");
      const gemHome = privatePath("ruby", "lib", "ruby", "gems", "3.4.0");
      return { command: ruby, args: [script, "stdio"], env: { GEM_HOME: gemHome, GEM_PATH: gemHome, RUBYOPT: "" } };
    }
    case "lemminx":
      return { command: javaPath(), args: ["-jar", existingFile(privatePath("lemminx", "lemminx.jar"), "private LemMinX")], env: { JAVA_HOME: privatePath("jre") } };
    case "sourcekit-lsp":
      {
        const binary = privatePath("swift", "usr", "bin", "sourcekit-lsp.exe");
        if (!existsSync(binary)) {
          fail(
            `SourceKit-LSP is install-time-auto and is not installed in the plugin; run runtime\\swift-bootstrap.ps1 after installing the official Windows prerequisites`,
          );
        }
        return { command: existingFile(binary, "private SourceKit-LSP"), args: [], env: {} };
      }
    case "jdtls": {
      const root = privatePath("jdtls");
      const launcher = firstMatching(path.join(root, "plugins"), /^org\.eclipse\.equinox\.launcher_.*\.jar$/u);
      const configuration = path.join(root, "config_win");
      if (!existsSync(configuration)) fail(`private JDT LS Windows configuration is missing: ${configuration}`);
      const workspace = path.join(dataRoot, "jdtls", hashWorkspace(path.resolve(process.cwd())));
      return {
        command: javaPath(),
        args: [
          "-Declipse.application=org.eclipse.jdt.ls.core.id1",
          "-Dosgi.bundles.defaultStartLevel=4",
          "-Declipse.product=org.eclipse.jdt.ls.core.product",
          "-Dlog.level=ALL",
          "-Xms256m",
          "-Xmx2g",
          "-jar",
          launcher,
          "-configuration",
          configuration,
          "-data",
          workspace,
        ],
        env: { JAVA_HOME: privatePath("jre") },
      };
    }
    default:
      fail(`unknown private language-server key: ${name}`, 2);
  }
}

function privateRustEnvironment() {
  const toolchainRoot = privatePath("rust-toolchain");
  const rustupHome = path.join(toolchainRoot, "rustup");
  const cargoHome = path.join(toolchainRoot, "cargo");
  const toolchains = path.join(rustupHome, "toolchains");
  const installed = existsSync(toolchains)
    ? readdirSync(toolchains).find((name) => name.endsWith("-x86_64-pc-windows-msvc"))
    : undefined;
  if (!installed) return {};
  const installedRoot = path.join(toolchains, installed);
  return {
    RUSTUP_HOME: rustupHome,
    CARGO_HOME: cargoHome,
    RUSTUP_TOOLCHAIN: installed,
    RUST_SRC_PATH: path.join(installedRoot, "lib", "rustlib", "src", "rust", "library"),
    PATH: [path.join(cargoHome, "bin"), path.join(installedRoot, "bin"), process.env.PATH || ""].join(path.delimiter),
  };
}

function privateGoEnvironment() {
  const goRoot = privatePath("go-1.27.1");
  return existsSync(path.join(goRoot, "bin", "go.exe"))
    ? {
        GOROOT: goRoot,
        GOPATH: path.join(dataRoot, "gopath"),
        GOTOOLCHAIN: "local",
        PATH: [path.join(goRoot, "bin"), process.env.PATH || ""].join(path.delimiter),
      }
    : {};
}

// Some real servers advertise the numeric LSP textDocumentSync form. The
// Harness backend requires an explicit openClose capability before it sends
// didOpen/didChange. This proxy preserves the server protocol while making
// that capability explicit; it never fabricates semantic query results.
function encodeLsp(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function consumeFrames(buffer, onMessage) {
  let remaining = buffer;
  for (;;) {
    const separator = remaining.indexOf(Buffer.from("\r\n\r\n", "ascii"));
    if (separator < 0) return remaining;
    const header = remaining.subarray(0, separator).toString("ascii");
    const match = /(?:^|\r?\n)Content-Length:\s*(\d+)/iu.exec(header);
    if (!match) fail(`invalid LSP header from ${key}`);
    const length = Number(match[1]);
    const bodyStart = separator + 4;
    if (remaining.length < bodyStart + length) return remaining;
    const body = remaining.subarray(bodyStart, bodyStart + length).toString("utf8");
    remaining = remaining.subarray(bodyStart + length);
    try {
      onMessage(JSON.parse(body));
    } catch (error) {
      fail(`invalid LSP JSON from ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

let parentBuffer = Buffer.alloc(0);
let childBuffer = Buffer.alloc(0);
let initializeId;

function sameId(left, right) {
  return left === right || String(left) === String(right);
}

function normalizeInitializeCapabilities(message) {
  if (!message || message.id === undefined || !sameId(message.id, initializeId)) return message;
  const result = message.result;
  if (!result || typeof result !== "object" || !result.capabilities || typeof result.capabilities !== "object") return message;
  const capabilities = { ...result.capabilities };
  const sync = capabilities.textDocumentSync;
  if (typeof sync === "number") capabilities.textDocumentSync = { change: sync, openClose: true };
  else if (sync && typeof sync === "object" && typeof sync.openClose !== "boolean") {
    capabilities.textDocumentSync = { ...sync, openClose: true };
  }
  return { ...message, result: { ...result, capabilities } };
}

function spawnServer(command, args, env) {
  try {
    return spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    fail(`failed to spawn ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "taskkill", "/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    child.kill("SIGTERM");
  }
}

function runStandardServer(spec) {
  const child = spawnServer(spec.command, spec.args, spec.env);
  process.stdin.on("data", (chunk) => {
    parentBuffer = consumeFrames(Buffer.concat([parentBuffer, chunk]), (message) => {
      if (message.method === "initialize") initializeId = message.id;
    });
    if (child?.stdin?.writable) child.stdin.write(chunk);
  });
  process.stdin.on("end", () => stopServer(child));
  child.stdout.on("data", (chunk) => {
    childBuffer = consumeFrames(Buffer.concat([childBuffer, chunk]), (message) => {
      process.stdout.write(encodeLsp(normalizeInitializeCapabilities(message)));
    });
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopServer(child);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child.once("error", (error) => fail(`language server ${key} failed: ${error.message}`));
  child.once("exit", (code, signal) => {
    if (!stopping && code && code !== 0) process.stderr.write(`[myharness-symbols] ${key} exited with code=${code} signal=${signal || "none"}\n`);
    process.exit(code ?? 0);
  });
}

function consumeTsServerFrames(buffer, onMessage) {
  let remaining = buffer;
  for (;;) {
    const separator = remaining.indexOf(Buffer.from("\r\n\r\n", "ascii"));
    if (separator < 0) return remaining;
    const header = remaining.subarray(0, separator).toString("ascii");
    const match = /(?:^|\r?\n)Content-Length:\s*(\d+)/iu.exec(header);
    if (!match) fail("invalid TypeScript server header from vue-language-server");
    const length = Number(match[1]);
    const bodyStart = separator + 4;
    if (remaining.length < bodyStart + length) return remaining;
    const body = remaining.subarray(bodyStart, bodyStart + length).toString("utf8");
    remaining = remaining.subarray(bodyStart + length);
    try {
      onMessage(JSON.parse(body));
    } catch (error) {
      fail(`invalid TypeScript server JSON from vue-language-server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function runVueServerWithTypeScriptProxy(spec) {
  const vue = spawnServer(spec.command, spec.args, spec.env);
  const tsserver = nodeModuleFile("typescript", "lib", "tsserver.js");
  const ts = spawnServer(process.execPath, [
    tsserver,
    "--globalPlugins",
    "@vue/typescript-plugin",
    "--pluginProbeLocations",
    nodeModulesRoots.join(path.delimiter),
    "--allowLocalPluginLoads",
  ], {});
  let vueBuffer = Buffer.alloc(0);
  let tsBuffer = Buffer.alloc(0);
  let nextTsSequence = 1;
  const pendingTsRequests = new Map();
  const openDocuments = new Map();

  const sendToVue = (message) => {
    if (vue.stdin?.writable) vue.stdin.write(encodeLsp(message));
  };
  const sendToTypeScript = (message) => {
    // TypeScript's tsserver reads newline-delimited JSON on stdin, while it
    // writes Content-Length framed protocol messages on stdout.
    if (ts.stdin?.writable) ts.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const sendDocumentToTypeScript = (message) => {
    const document = message.params?.textDocument;
    if (!document?.uri || typeof document.text !== "string") return;
    let file;
    try {
      file = fileURLToPath(document.uri).replaceAll("\\", "/");
    } catch {
      return;
    }
    openDocuments.set(file, document.text);
    const sequence = nextTsSequence++;
    sendToTypeScript({
      seq: sequence,
      type: "request",
      command: "open",
      arguments: {
        file,
        fileContent: document.text,
        projectRootPath: process.cwd().replaceAll("\\", "/"),
        scriptKindName: document.languageId === "vue" ? "TS" : undefined,
      },
    });
  };
  const tsPositionAt = (text, offset) => {
    const bounded = Math.max(0, Math.min(offset, text.length));
    let line = 1;
    let lineStart = 0;
    for (let index = 0; index < bounded; index += 1) {
      if (text[index] === "\n") {
        line += 1;
        lineStart = index + 1;
      }
    }
    return { line, offset: bounded - lineStart + 1 };
  };
  const lspOffsetAt = (text, position) => {
    const requestedLine = Math.max(0, Number.isInteger(position?.line) ? position.line : 0);
    const requestedCharacter = Math.max(0, Number.isInteger(position?.character) ? position.character : 0);
    let line = 0;
    let lineStart = 0;
    while (line < requestedLine && lineStart < text.length) {
      const newline = text.indexOf("\n", lineStart);
      if (newline < 0) {
        lineStart = text.length;
        break;
      }
      line += 1;
      lineStart = newline + 1;
    }
    const lineEnd = text.indexOf("\n", lineStart);
    const contentEnd = lineEnd < 0 ? text.length : lineEnd - (lineEnd > lineStart && text[lineEnd - 1] === "\r" ? 1 : 0);
    return Math.min(lineStart + requestedCharacter, contentEnd);
  };
  const applyDocumentChanges = (message) => {
    const document = message.params?.textDocument;
    if (!document?.uri || !Array.isArray(message.params?.contentChanges)) return;
    let file;
    try {
      file = fileURLToPath(document.uri).replaceAll("\\", "/");
    } catch {
      return;
    }
    let text = openDocuments.get(file);
    if (typeof text !== "string") return;
    const oldText = text;
    for (const change of message.params.contentChanges) {
      if (!change || typeof change.text !== "string") continue;
      if (!change.range) {
        text = change.text;
        continue;
      }
      const start = lspOffsetAt(text, change.range.start);
      const end = lspOffsetAt(text, change.range.end);
      text = `${text.slice(0, Math.min(start, end))}${change.text}${text.slice(Math.max(start, end))}`;
    }
    openDocuments.set(file, text);
    const end = tsPositionAt(oldText, oldText.length);
    sendToTypeScript({
      seq: nextTsSequence++,
      type: "request",
      command: "change",
      arguments: {
        file,
        line: 1,
        offset: 1,
        endLine: end.line,
        endOffset: end.offset,
        insertString: text,
      },
    });
  };
  const closeDocumentInTypeScript = (message) => {
    const document = message.params?.textDocument;
    if (!document?.uri) return;
    let file;
    try {
      file = fileURLToPath(document.uri).replaceAll("\\", "/");
    } catch {
      return;
    }
    if (!openDocuments.has(file)) return;
    openDocuments.delete(file);
    sendToTypeScript({
      seq: nextTsSequence++,
      type: "request",
      command: "close",
      arguments: { file },
    });
  };
  const forwardVueMessage = (message) => {
    const requestParams = message.method === "tsserver/request" && Array.isArray(message.params) && message.params.length === 1 && Array.isArray(message.params[0])
      ? message.params[0]
      : message.params;
    if (message.method === "tsserver/request" && Array.isArray(requestParams) && requestParams.length >= 3) {
      const [vueRequestId, command, args] = requestParams;
      const sequence = nextTsSequence++;
      pendingTsRequests.set(sequence, vueRequestId);
      sendToTypeScript({
        seq: sequence,
        type: "request",
        command,
        arguments: args,
      });
      return;
    }
    process.stdout.write(encodeLsp(normalizeInitializeCapabilities(message)));
  };
  const forwardTypeScriptMessage = (message) => {
    if (message?.type !== "response" || !Number.isInteger(message.request_seq)) return;
    const vueRequestId = pendingTsRequests.get(message.request_seq);
    if (vueRequestId === undefined) return;
    pendingTsRequests.delete(message.request_seq);
    // @vue/language-server resolves its tsserver request with the response
    // body, not with the TypeScript protocol envelope.
    sendToVue({
      jsonrpc: "2.0",
      method: "tsserver/response",
      params: [[vueRequestId, message.body]],
    });
  };

  process.stdin.on("data", (chunk) => {
    parentBuffer = consumeFrames(Buffer.concat([parentBuffer, chunk]), (message) => {
      if (message.method === "initialize") initializeId = message.id;
      if (message.method === "textDocument/didOpen") sendDocumentToTypeScript(message);
      if (message.method === "textDocument/didChange") applyDocumentChanges(message);
      if (message.method === "textDocument/didClose") closeDocumentInTypeScript(message);
      if (message.method !== "tsserver/response") sendToVue(message);
    });
  });
  vue.stdout.on("data", (chunk) => {
    vueBuffer = consumeFrames(Buffer.concat([vueBuffer, chunk]), forwardVueMessage);
  });
  ts.stdout.on("data", (chunk) => {
    tsBuffer = consumeTsServerFrames(Buffer.concat([tsBuffer, chunk]), forwardTypeScriptMessage);
  });
  vue.stderr.on("data", (chunk) => process.stderr.write(chunk));
  ts.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopServer(vue);
    stopServer(ts);
  };
  process.stdin.on("end", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  vue.once("error", (error) => {
    stop();
    fail(`language server ${key} failed: ${error.message}`);
  });
  ts.once("error", (error) => {
    stop();
    fail(`TypeScript proxy for ${key} failed: ${error.message}`);
  });
  vue.once("exit", (code, signal) => {
    if (!stopping && code && code !== 0) process.stderr.write(`[myharness-symbols] ${key} exited with code=${code} signal=${signal || "none"}\n`);
    if (!stopping) stopServer(ts);
    process.exit(code ?? 0);
  });
  ts.once("exit", (code, signal) => {
    if (!stopping && code && code !== 0) process.stderr.write(`[myharness-symbols] private TypeScript proxy exited with code=${code} signal=${signal || "none"}\n`);
    if (!stopping && vue.exitCode === null) stopServer(vue);
  });
}

if (!key) fail("language-server key is required", 2);
const spec = specFor(key);
if (key === "vue-language-server") runVueServerWithTypeScriptProxy(spec);
else runStandardServer(spec);
