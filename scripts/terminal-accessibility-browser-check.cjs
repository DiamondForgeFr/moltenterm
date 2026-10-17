// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const deadline = setTimeout(() => {
        console.error("Terminal accessibility fixture did not finish");
        app.exit(1);
    }, 60000);
    try {
        const bundle = await build({
            entryPoints: ["scripts/fixtures/terminal-accessibility.ts"],
            bundle: true,
            platform: "browser",
            format: "iife",
            write: false,
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [
                {
                    name: "accessibility-environment",
                    setup(builder) {
                        builder.onResolve({ filter: /^@\/app\/store\/global$/ }, () => ({
                            path: path.resolve("scripts/fixtures/terminal-accessibility-global.ts"),
                        }));
                        // Expand Vite's eager locale glob without replacing the production i18n model.
                        builder.onLoad({ filter: /\/i18n-core\.ts$/ }, async ({ path: file }) => ({
                            contents:
                                'import en from "./locales/en.json"; import fr from "./locales/fr.json";\n' +
                                (await fs.readFile(file, "utf8")).replace(
                                    'import.meta.glob("./locales/*.json", { eager: true, import: "default" })',
                                    '({ "./locales/en.json": en, "./locales/fr.json": fr })'
                                ),
                            loader: "ts",
                        }));
                        if (process.env.MOLTENTERM_ACCESSIBILITY_MUTATION === "1") {
                            builder.onLoad({ filter: /\/screen-reader\.ts$/ }, async ({ path: file }) => ({
                                contents: (await fs.readFile(file, "utf8")).replace(
                                    "terminal.options.screenReaderMode = value",
                                    "void value"
                                ),
                                loader: "ts",
                            }));
                        }
                    },
                },
            ],
        });
        const win = new BrowserWindow({
            show: false,
            width: 900,
            height: 600,
            webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
        });
        win.webContents.on("console-message", (event) => {
            if (event.level === "error") console.error(event.message);
        });
        await win.loadURL("about:blank");
        win.webContents.focus();
        await win.webContents.insertCSS(await fs.readFile(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
        await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
        const result = await win.webContents.executeJavaScript("globalThis.runTerminalAccessibilityChecks()");
        const output = path.join(os.tmpdir(), "mt808-accessibility");
        await fs.mkdir(output, { recursive: true });
        const report = { result: "PASS", ...result, electron: process.versions.electron, output };
        await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
        clearTimeout(deadline);
        app.exit(0);
    } catch (error) {
        console.error(error);
        clearTimeout(deadline);
        app.exit(1);
    }
});
