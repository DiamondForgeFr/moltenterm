// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    win.webContents.on("console-message", (event) => console.log(event.message));
    try {
        const result = await build({
            entryPoints: ["scripts/fixtures/dialog-focus.tsx"], bundle: true, write: false, platform: "browser",
            format: "iife", jsx: "automatic", loader: { ".css": "empty" },
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [{ name: "disposable-dialog-actions", setup(builder) {
                builder.onResolve({ filter: /(?:^@\/app\/store\/(?:global|services|wos)$|^@\/layout\/index$|^@\/util\/util$|\/i18n\/(?:i18n|i18n-core|server-text)$|\/(?:busy-close-store|busy-close-main|notifications-store|reopen-store|worktree-store)$)/ },
                    () => ({ path: path.resolve("scripts/fixtures/dialog-focus-mocks.ts") }));
            } }],
        });
        await win.loadURL("about:blank");
        win.webContents.debugger.attach("1.3");
        await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
        await win.webContents.executeJavaScript(result.outputFiles[0].text);
        const iterations = Number(process.env.MOLTENTERM_DIALOG_REPEATS ?? 1);
        let checks;
        for (let i = 0; i < iterations; i++) {
            checks = await win.webContents.executeJavaScript("globalThis.runDialogChecks()");
        }
        await win.webContents.executeJavaScript("globalThis.prepareNativeDialog()");
        const untilFocused = async (text) => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                if (await win.webContents.executeJavaScript("document.activeElement.textContent") === text) return;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            throw new Error(`Native keyboard did not focus ${text}`);
        };
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab", modifiers: ["shift"] });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab", modifiers: ["shift"] });
        await untilFocused("End session");
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
        await untilFocused("Keep it");
        console.log(JSON.stringify({ result: "PASS", iterations, checks, nativeKeyboard: "PASS",
            platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome }, null, 2));
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
