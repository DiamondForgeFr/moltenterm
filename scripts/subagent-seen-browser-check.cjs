// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const deadline = setTimeout(() => {
        console.error("Subagent fixture did not finish");
        app.exit(1);
    }, 60000);
    try {
        const result = await build({
            entryPoints: ["scripts/fixtures/subagent-seen.tsx"],
            bundle: true,
            write: false,
            platform: "browser",
            format: "iife",
            jsx: "automatic",
            loader: { ".css": "empty", ".scss": "empty" },
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [
                {
                    name: "fixture",
                    setup(builder) {
                        builder.onResolve(
                            {
                                filter: /(?:^@\/app\/store\/(?:global|wps|wshrpcutil)$|^@\/util\/util$|\/companion-follow$|\/agent-state-store$|\/dialog-frame$|\/i18n\/i18n$|\/sidebar-agents$|\/tab-activity$|\/agent-info-window$)/,
                            },
                            () => ({ path: path.resolve("scripts/fixtures/subagent-seen-mocks.tsx") })
                        );
                        builder.onResolve({ filter: /i18n-locales-lazy$/ }, () => ({
                            path: path.resolve("scripts/fixtures/subagent-seen-mocks.tsx"),
                        }));
                        if (process.env.MOLTENTERM_SUBAGENT_MUTATION === "1") {
                            builder.onLoad({ filter: /\/subagent-info-window\.tsx$/ }, async ({ path: file }) => ({
                                contents: (await fs.readFile(file, "utf8")).replace(
                                    "AgentInfoModel.getInstance().markSubSeen(blockId, live);",
                                    ""
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
        console.log(await win.webContents.executeJavaScript("globalThis.runSubagentSeenChecks()"));
        clearTimeout(deadline);
        app.exit(0);
    } catch (error) {
        console.error(error);
        clearTimeout(deadline);
        app.exit(1);
    }
});
