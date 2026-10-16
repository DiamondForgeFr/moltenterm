// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 900, height: 600,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.on("console-message", (event) => {
        if (event.level === "error") console.error(event.message);
    });
    const deadline = setTimeout(() => { console.error("Tab close fixture did not finish"); app.exit(1); }, 60000);
    try {
        const result = await build({ entryPoints: ["scripts/fixtures/tab-close.tsx"], bundle: true, write: false,
            platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty", ".scss": "empty" },
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [{ name: "tab-close-environment", setup(builder) {
                builder.onResolve({ filter: /(?:^@\/app\/waveenv\/waveenv$|^@\/util\/util$|\/i18n\/i18n$)/ },
                    () => ({ path: path.resolve("scripts/fixtures/tab-close-mocks.ts") }));
                if (process.env.MOLTENTERM_CLOSE_MUTATION === "1") {
                    builder.onLoad({ filter: /\/hold-to-close\.tsx$/ }, async ({ path: file }) => ({
                        contents: (await fs.readFile(file, "utf8")).replace("onSemanticActivate={requestConfirmation}", "onSemanticActivate={undefined}"), loader: "tsx",
                    }));
                }
            } }],
        });
        await win.loadURL("about:blank");
        win.webContents.focus();
        const assets = "dist/frontend/assets";
        const cssFiles = (await fs.readdir(assets)).filter(file => file.endsWith(".css"));
        if (!cssFiles.length) throw new Error("Run npm run build:prod before the browser check");
        await win.webContents.insertCSS((await Promise.all(cssFiles.map(file => fs.readFile(path.join(assets, file), "utf8")))).join("\n"));
        await win.webContents.executeJavaScript(result.outputFiles[0].text);
        const repetitions = Number(process.env.MOLTENTERM_CLOSE_REPETITIONS || 1);
        let report;
        for (let iteration = 0; iteration < repetitions; iteration++) {
            report = await win.webContents.executeJavaScript("globalThis.runTabCloseChecks()");
            for (const enabled of [true, false]) {
                for (const keyCode of ["ENTER", "SPACE"]) {
                    await win.webContents.executeJavaScript(`globalThis.prepareNativeTabClose({enabled:${enabled}})`);
                    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
                    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
                    await win.webContents.executeJavaScript("globalThis.assertNativeTabClose()");
                    await win.webContents.executeJavaScript("globalThis.cancelNativeTabClose()");
                }
            }
        }
        const output = process.env.MOLTENTERM_CLOSE_OUT || path.join(os.tmpdir(), "mt809-close");
        await fs.mkdir(output, { recursive: true });
        await win.webContents.executeJavaScript("globalThis.showTabCloseConfirmation()");
        await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        await fs.writeFile(path.join(output, "confirmation.png"), (await win.webContents.capturePage()).toPNG());
        const summary = { result: "PASS", ...report, repetitions, nativeKeyboardCases: 4 * repetitions,
            electron: process.versions.electron, chromium: process.versions.chrome, output };
        await fs.writeFile(path.join(output, "report.json"), JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary, null, 2));
        clearTimeout(deadline);
        app.exit(0);
    } catch (error) {
        console.error(error);
        clearTimeout(deadline);
        app.exit(1);
    }
});
