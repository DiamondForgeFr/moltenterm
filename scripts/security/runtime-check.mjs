// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Real dependency compatibility checks with disposable loopback servers; no application/user data or external URLs.
/* global AbortSignal, clearTimeout, console, process, setImmediate, setTimeout, URL */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dns from "node:dns";
import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../package.json", import.meta.url));
const deadline = setTimeout(() => {
    console.error("dependency runtime checks exceeded the 90 second failure bound");
    process.exit(1);
}, 90_000);
deadline.unref();
const { quote } = require("shell-quote");
for (const name of ["plain.txt", "two words", "quote'\"", "two\nlines", "$(printf injected)", "; printf injected", "-n"]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf '%s' ${quote([name])}`], { encoding: "utf8" }), name);
}

const sdkRequire = createRequire(require.resolve("@ai-sdk/provider-utils"));
const { Agent, fetch: undiciFetch } = sdkRequire("undici");
let requests = 0;
const server = http.createServer((req, res) => {
    requests++;
    if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/stream" }).end();
        return;
    }
    res.write("stream-");
    setImmediate(() => res.end("ok"));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://dependency-check.invalid:${server.address().port}`;
const agent = new Agent({ connect: { lookup(host, options, callback) {
    assert.equal(host, "dependency-check.invalid");
    callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
} } });
const oldLookup = dns.lookup;
try {
    const response = await undiciFetch(`${url}/stream`, { dispatcher: agent, signal: AbortSignal.timeout(60_000) });
    assert.equal(await response.text(), "stream-ok");
    const redirect = await undiciFetch(`${url}/redirect`, { dispatcher: agent, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    assert.equal(redirect.status, 302);
    await redirect.body.cancel();

    // Exercise the actual SDK's default Agent and safe lookup. A public hostname resolving to loopback is rejected
    // before the local server receives anything; passing a custom fetch here would bypass the compatibility path.
    let guardedLookups = 0;
    dns.lookup = (host, options, callback) => {
        assert.equal(host, "dependency-check.invalid");
        guardedLookups++;
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
    };
    const { fetchWithValidatedEndpoint } = sdkRequire("@ai-sdk/provider-utils");
    const before = requests;
    await assert.rejects(
        fetchWithValidatedEndpoint({ url: `${url}/private`, init: { signal: AbortSignal.timeout(60_000) } }),
        (error) => /resolved to disallowed IP address 127\.0\.0\.1/.test(error.cause?.message)
    );
    assert.equal(guardedLookups, 1);
    assert.equal(requests, before, "SDK default download must reject a private DNS answer before HTTP");
} finally {
    dns.lookup = oldLookup;
    await agent.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const { WebSocket, WebSocketServer } = require("ws");
const sockets = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 16 });
await once(sockets, "listening");
let lengthError;
sockets.on("connection", (socket) => {
    socket.on("error", (error) => { lengthError = error.code; });
    socket.on("message", (data) => socket.send(data));
});
const client = new WebSocket(`ws://127.0.0.1:${sockets.address().port}`);
try {
    await once(client, "open");
    const message = once(client, "message");
    client.send("small-", { fin: false });
    client.send("data", { fin: true });
    assert.equal((await message)[0].toString(), "small-data");
    const closed = once(client, "close");
    client.send("x".repeat(17));
    assert.equal((await closed)[0], 1009);
    assert.equal(lengthError, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
} finally {
    client.terminate();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
}
console.log("dependency runtime checks: shell quoting, scoped Undici/SDK DNS guard and bounded fragmented WebSocket passed");
clearTimeout(deadline);
