// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

const assert = require("node:assert/strict");
const { app, BrowserWindow } = require("electron");

const fixture = "globalThis.settingsSliderFixture";
const slider = 'document.querySelector(\'[data-setting="window:opacity"] input[type="range"]\')';
const nav = (name) =>
    `Array.from(document.querySelectorAll('nav button')).find(b => b.title === ${JSON.stringify(name)})`;
const value = (next) =>
    `(() => { const el = ${slider}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '${next}'); el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); })()`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1400, height: 1000, show: process.env.MOLTENTERM_BACKGROUND !== "1" });
    const read = (expression) => win.webContents.executeJavaScript(expression, true);
    const until = async (expression, description) => {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            if (await read(expression)) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`Timed out: ${description}`);
    };
    try {
        await win.loadFile(process.env.MOLTENTERM_SLIDER_FIXTURE_FILE);
        await until(`!!(${fixture} && ${slider})`, "mounted Settings screen");
        await read(value(0.3));
        await until(`${fixture}.requests.length === 1`, "first request");
        await read(`${value(0.7)}; ${nav("General")}.click()`);
        await until(`!${slider}`, "real section change unmounts slider");
        assert.deepEqual(await read(`${fixture}.calls`), [{ "window:opacity": 0.3 }]);
        await read(`${fixture}.resolve()`);
        await until(`${fixture}.requests.length === 1`, "serialized final request");
        assert.deepEqual(await read(`${fixture}.calls`), [{ "window:opacity": 0.3 }, { "window:opacity": 0.7 }]);
        await read(`${fixture}.resolve(); ${nav("Appearance")}.click()`);
        await until(`${slider}?.value === '0.7'`, "final persisted value on return");
        await read(`${fixture}.close()`);
        await until(`!${slider}`, "settings close");
        await read(`${fixture}.reopen()`);
        await until(`${slider}?.value === '0.7'`, "persisted value on reopen");
        await read(`${slider}.focus()`);
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
        await until(`${fixture}.requests.length === 1`, "native keyboard change");
        assert.equal(await read(`${slider}.value`), "0.65");
        await read(`${nav("General")}.click(); ${fixture}.reject()`);
        await until(
            `!!document.querySelector('[data-testid="toast"][role="alert"] button')`,
            "failure visible after unmount"
        );
        await read(
            `Array.from(document.querySelectorAll('[data-testid="toast"] button')).find(b => b.textContent.trim() === 'Retry').click()`
        );
        await until(`${fixture}.requests.length === 1`, "explicit retry");
        await read(`${fixture}.resolve(); ${nav("Appearance")}.click()`);
        await until(
            `${slider}?.value === '0.65' && !document.querySelector('[data-testid="toast"][role="alert"]')`,
            "retry persisted and notice cleared"
        );
        console.log(
            JSON.stringify(
                {
                    result: "PASS",
                    checks: [
                        "real section change",
                        "serialized trailing write",
                        "remount/reopen",
                        "native keyboard",
                        "failure after unmount",
                        "explicit retry",
                    ],
                    calls: await read(`${fixture}.calls`),
                },
                null,
                2
            )
        );
        app.exit(0);
    } catch (error) {
        console.error(error);
        console.error(await read("document.body.innerText.slice(0, 4000)").catch(() => "Page unavailable"));
        app.exit(1);
    }
});
