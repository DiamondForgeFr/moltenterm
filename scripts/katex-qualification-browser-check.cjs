// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const os = require("node:os");
const path = require("node:path");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    win.webContents.on("console-message", (event) => console.log(event.message));
    try {
        const result = await build({ entryPoints: ["scripts/fixtures/katex-qualification.tsx"], bundle: true,
            write: false, outdir: path.join(os.tmpdir(), "moltenterm-katex-fixture-bundle"), platform: "browser", format: "iife", jsx: "automatic",
            loader: { ".css": "css", ".scss": "empty", ".svg": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
            define: { "process.env.NODE_ENV": '"production"' } });
        await win.loadURL("data:text/html,<!doctype html><html><body><div id='root'></div></body></html>");
        const js = result.outputFiles.find((file) => file.path.endsWith(".js"));
        const css = result.outputFiles.find((file) => file.path.endsWith(".css"));
        if (!js || !css || !css.text.includes("KaTeX_Main")) throw new Error("KaTeX stylesheet not bundled");
        await win.webContents.insertCSS(css.text);
        await win.webContents.executeJavaScript(js.text);
        const font = await win.webContents.executeJavaScript(`document.fonts.load('16px KaTeX_Main').then(x => x.length > 0)`);
        if (!font) throw new Error("KaTeX font failed to load");
        const checks = await win.webContents.executeJavaScript("window.runKatexChecks()");
        console.log(JSON.stringify({ result: "PASS", electron: process.versions.electron, cssFont: "PASS", checks }));
        app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
});
