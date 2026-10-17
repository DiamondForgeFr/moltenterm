// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
        const result = await build({
            entryPoints: ["scripts/fixtures/mission-hooks.tsx"],
            bundle: true,
            write: false,
            platform: "browser",
            format: "iife",
            jsx: "automatic",
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [
                {
                    name: "mission-transports",
                    setup(builder) {
                        builder.onResolve(
                            {
                                filter: /(?:^@\/app\/store\/(?:wps|wshrpcutil)$|^@\/util\/util$|\/i18n\/(?:i18n|i18n-core|server-text)$|\/tab-activity$|\/view360\/offcarpet-model$)/,
                            },
                            () => ({
                                path: path.resolve("scripts/fixtures/mission-hooks-mocks.ts"),
                            })
                        );
                    },
                },
            ],
        });
        await win.loadURL("about:blank");
        await win.webContents.executeJavaScript(result.outputFiles[0].text);
        const checks = await win.webContents.executeJavaScript("globalThis.runMissionChecks()");
        console.log(JSON.stringify({ result: "PASS", checks }, null, 2));
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
