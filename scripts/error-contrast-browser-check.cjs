// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Run after build:prod with a disposable --user-data-dir. Real components, built shell CSS, mocked side effects.
const fs = require("node:fs/promises");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const { build } = require("esbuild");

if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1100, height: 780,
        webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    try {
        const output = process.env.MOLTENTERM_CONTRAST_OUT || "/private/tmp/mt817-contrast";
        await fs.mkdir(output, { recursive: true });
        const result = await build({
            entryPoints: ["scripts/fixtures/error-contrast.tsx"], bundle: true, write: false,
            platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty" },
            define: { "process.env.NODE_ENV": '"development"' },
            plugins: [{ name: "contrast-read-only-fixtures", setup(builder) {
                builder.onResolve({ filter: /(?:^@\/app\/store\/(?:global|services|wos)$|^@\/layout\/index$|^@\/util\/util$|\/i18n\/(?:i18n|i18n-core|server-text)$|\/(?:busy-close-store|busy-close-main|notifications-store|reopen-store|worktree-store|molten-host)$)/ },
                    () => ({ path: path.resolve("scripts/fixtures/error-contrast-mocks.ts") }));
            } }],
        });
        const assets = "dist/frontend/assets";
        const cssFiles = (await fs.readdir(assets)).filter(file => file.endsWith(".css"));
        if (!cssFiles.length) throw new Error("Build the production frontend before checking contrast");
        const css = (await Promise.all(cssFiles.map(file => fs.readFile(path.join(assets, file), "utf8")))).join("\n");
        await win.loadURL("about:blank");
        await win.webContents.insertCSS(css);
        await win.webContents.insertCSS("body { margin: 0; background: var(--mt-surface-1); color: var(--mt-text-main); font-family: sans-serif; }");
        if (process.env.MOLTENTERM_CONTRAST_MUTATION === "1") {
            await win.webContents.insertCSS(".text-danger { color: var(--mt-state-error) !important; }");
        }
        await win.webContents.executeJavaScript(result.outputFiles[0].text);
        const recipes = new Set(["text-danger"]);
        const inventory = [];
        async function inspect(dir) {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                const file = path.join(dir, entry.name);
                if (entry.isDirectory()) await inspect(file);
                else if (/\.tsx?$/.test(file) && !file.includes(".test.")) {
                    const lines = (await fs.readFile(file, "utf8")).split("\n");
                    lines.forEach((line, index) => {
                        if (!line.includes("text-danger") && !(line.includes("text-primary") && line.includes("bg-error"))) return;
                        inventory.push({ file, line: index + 1, source: line.trim() });
                        for (const token of line.match(/(?:hover:)?bg-error\/\d+/g) ?? []) {
                            recipes.add(`${line.includes("text-danger") ? "text-danger" : "text-primary"} ${token.replace("hover:", "")}`);
                        }
                    });
                }
            }
        }
        await inspect("frontend/moltenterm-shell");
        const report = await win.webContents.executeJavaScript(`globalThis.runContrastChecks(${JSON.stringify([...recipes])})`);
        report.recipes = [...recipes];
        report.inventory = inventory;
        report.runtime = { electron: process.versions.electron, chromium: process.versions.chrome };
        await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
        for (const kind of ["worktree", "session", "mods"]) {
            await win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--mt-accent', '#ff7c0d'); globalThis.renderContrastCase(${JSON.stringify(kind)})`);
            await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
            await fs.writeFile(path.join(output, `${kind}.png`), (await win.webContents.capturePage()).toPNG());
        }
        console.log(JSON.stringify({ result: "PASS", samples: report.samples, accents: report.accents,
            minimum: report.minimum, recipes: report.recipes, output, ...report.runtime }, null, 2));
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
});
