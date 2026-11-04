// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtempSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { app, BrowserWindow, session } = require("electron");
const { build } = require("esbuild");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.setPath("userData", process.env.MOLTENTERM_CLIPBOARD_DATA_DIR || mkdtempSync(path.join(os.tmpdir(), "moltenterm-clipboard-app-")));
const deadline = setTimeout(() => { console.error("Clipboard browser check exceeded its 60 second failure bound"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
    let win;
    try {
        const isolated = session.fromPartition(`clipboard-check-${randomUUID()}`);
        const requests = [];
        isolated.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
            if (details.url.startsWith("https://clipboard-check.invalid/") && !details.url.endsWith("/barrier")) requests.push(details.url);
            callback({ cancel: !details.url.startsWith("data:") && details.url !== "about:blank" });
        });
        win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        await win.loadURL("data:text/html,<!doctype html><html><body>Clipboard regression fixture</body></html>");
        const bundled = await build({
            entryPoints: ["scripts/fixtures/clipboard-security.ts"], bundle: true, write: false, platform: "browser", format: "iife",
            plugins: [{ name: "unused-clipboard-rpc", setup(builder) {
                // Only image-file creation needs RPC. The tested production extraction functions remain intact.
                builder.onResolve({ filter: /^@\/app\/store\/(?:wshclientapi|wshrpcutil)$/ }, (args) => ({ path: args.path, namespace: "unused-rpc" }));
                builder.onLoad({ filter: /.*/, namespace: "unused-rpc" }, () => ({ contents: "export const RpcApi = {}; export const TabRpcClient = {};", loader: "js" }));
            } }],
        });
        await win.webContents.executeJavaScript(bundled.outputFiles[0].text);
        await win.webContents.executeJavaScript("globalThis.clipboardPositiveControl()");
        assert.deepEqual(requests, ["https://clipboard-check.invalid/control"], "The test must detect an active detached div's resource load");
        requests.length = 0;
        const repeats = Number(process.env.MOLTENTERM_CLIPBOARD_REPEATS || 1);
        assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 100);
        let checks;
        for (let i = 0; i < repeats; i++) {
            checks = await win.webContents.executeJavaScript("globalThis.runClipboardChecks()");
            assert.deepEqual(requests, [], "HTML clipboard content must not request resources");
        }
        console.log(JSON.stringify({ result: "PASS", electron: process.versions.electron, chromium: process.versions.chrome, repeats, positiveControl: "PASS", resourceRequests: requests.length, ...checks }));
    } finally {
        clearTimeout(deadline);
        win?.destroy();
    }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
