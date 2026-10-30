// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs/promises");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const deadline = setTimeout(() => {
        console.error("Toast fixture did not finish");
        app.exit(1);
    }, 60000);
    try {
        const result = await build({
            entryPoints: ["scripts/fixtures/toast-replacement.tsx"],
            bundle: true,
            write: false,
            platform: "browser",
            format: "iife",
            jsx: "automatic",
            loader: { ".css": "empty", ".scss": "empty" },
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [
                {
                    name: "fixture-i18n",
                    setup(builder) {
                        builder.onResolve({ filter: /(?:^\.\/i18n\/i18n$|\/i18n\/i18n$)/ }, () => ({
                            path: path.resolve("scripts/fixtures/toast-replacement-mocks.ts"),
                        }));
                        builder.onResolve({ filter: /i18n-locales-lazy$/ }, () => ({
                            path: path.resolve("scripts/fixtures/toast-replacement-mocks.ts"),
                        }));
                        if (process.env.MOLTENTERM_TOAST_MUTATION === "1") {
                            builder.onLoad({ filter: /\/toast-stack\.tsx$/ }, async ({ path: file }) => ({
                                contents: (await fs.readFile(file, "utf8")).replace(
                                    "key={`${toast.id}:${toast.revision}`}",
                                    "key={toast.id}"
                                ),
                                loader: "tsx",
                            }));
                        }
                    },
                },
            ],
        });
        const win = new BrowserWindow({
            show: false,
            webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
        });
        win.webContents.on("console-message", (event) => {
            if (event.level === "error") console.error(event.message);
        });
        await win.loadURL("about:blank");
        await win.webContents.executeJavaScript(result.outputFiles[0].text);
        console.log(await win.webContents.executeJavaScript("globalThis.runToastReplacementChecks()"));
        clearTimeout(deadline);
        app.exit(0);
    } catch (error) {
        console.error(error);
        clearTimeout(deadline);
        app.exit(1);
    }
});
