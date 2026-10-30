// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { build } = require(path.resolve("node_modules/esbuild"));
const target = process.env.MATERIALS_HOOK || path.resolve("frontend/moltenterm-shell/library/use-materials-drawer.ts");
if (process.platform === "darwin") app.setActivationPolicy("accessory");
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    try {
        const plugin = {
            name: "fixture-mocks",
            setup(b) {
                b.onResolve({ filter: /^\.\/use-materials-drawer$/ }, () => ({ path: target }));
                b.onResolve(
                    { filter: /^(@\/app\/store\/(wps|wshrpcutil)|@\/util\/util|\.\/materials-model)$/ },
                    (args) => ({ path: args.path, namespace: "mock" })
                );
                b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
                    contents: args.path.endsWith("wps")
                        ? "export const waveEventSubscribeSingle=(...x)=>window.testSubscribe(...x)"
                        : args.path.endsWith("wshrpcutil")
                          ? "export const TabRpcClient={wshRpcCall:(...x)=>window.testRpc(...x)}"
                          : args.path.endsWith("util")
                            ? "export const fireAndForget=(f)=>{void f()}"
                            : "export const MaterialsEvent='materials'; export const MaterialsListCommand='list'; export const MaterialsRoute='route'",
                    loader: "js",
                }));
            },
        };
        const built = await build({
            entryPoints: ["frontend/moltenterm-shell/library/materials-refresh-browser-fixture.tsx"],
            absWorkingDir: process.cwd(),
            nodePaths: [path.resolve("node_modules")],
            bundle: true,
            write: false,
            platform: "browser",
            format: "iife",
            jsx: "automatic",
            plugins: [plugin],
            define: { "process.env.NODE_ENV": '"development"' },
        });
        await win.loadURL("data:text/html,<!doctype html><div id='root'></div>");
        await win.webContents.executeJavaScript(`window.testBaseline = ${process.env.MATERIALS_BASELINE === "1"}`);
        await win.webContents.executeJavaScript(built.outputFiles[0].text);
        console.log(JSON.stringify(await win.webContents.executeJavaScript("window.runChecks()")));
        app.exit(0);
    } catch (e) {
        console.error(e);
        app.exit(1);
    }
});
