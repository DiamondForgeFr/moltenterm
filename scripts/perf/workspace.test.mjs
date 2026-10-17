// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { evaluate, isContextLost, neverRan, pinDefaultContext } from "./lib/cdp.mjs";
import { Driver } from "./lib/workspace.mjs";

const NotFound = "Cannot find context with specified id";
const Destroyed = "Execution context was destroyed.";

// A MoltenTerm window seen through CDP: workspaces, the on-screen log of the main-process poll and the app log.
// `faults` replaces the page's context on the next evaluation whose expression contains `match`, before it runs
// (`after` false, CDP refuses it) or after it ran (`after` true).
function fakeApp() {
  const app = {
    workspaces: [{ id: "ws-1", tabs: ["tab-1"], active: "tab-1" }],
    screen: [],
    log: [],
    calls: { create: 0, delete: 0, switch: 0 },
    faults: [],
    pagesOpened: 0,
    pagesClosed: 0,
    next: 2,
  };
  const run = (expr) => {
    if (expr.includes("window.api.createWorkspace()")) {
      app.calls.create++;
      const n = app.next++;
      app.workspaces.push({ id: `ws-${n}`, tabs: [`tab-${n}`], active: `tab-${n}` });
      app.log.push({ t: Date.now(), s: "create-workspace 1" });
      app.screen.push([Date.now(), `tab-${n}`]);
      return 1;
    }
    const del = expr.match(/window\.api\.deleteWorkspace\("([^"]+)"\)/);
    if (del) {
      app.calls.delete++;
      app.log.push({ t: Date.now(), s: `delete-workspace ${del[1]} 1` });
      app.workspaces = app.workspaces.filter((w) => w.id !== del[1]);
      return 1;
    }
    const sw = expr.match(/window\.api\.switchWorkspace\("([^"]+)"\)/);
    if (sw) {
      app.calls.switch++;
      app.log.push({ t: Date.now(), s: `switch-workspace ${sw[1]} 1` });
      app.screen.push([Date.now(), app.workspaces.find((w) => w.id === sw[1]).active]);
      return 1;
    }
    if (expr.includes("GetWorkspace")) {
      return app.workspaces.map((w) => ({ ...w }));
    }
    if (expr.includes("ListWorkspaces")) {
      return app.workspaces.map((w) => ({ workspaceid: w.id }));
    }
    if (expr.includes("globalAtoms.workspace")) {
      return app.workspaces[0].id;
    }
    if (expr.includes("throwsReferenceError")) {
      throw new Error("ReferenceError: throwsReferenceError is not defined");
    }
    throw new Error(`unexpected expression ${expr}`);
  };
  const evaluatePage = (expr) => {
    const i = app.faults.findIndex((f) => expr.includes(f.match));
    if (i >= 0) {
      const [f] = app.faults.splice(i, 1);
      if (f.after) {
        run(expr);
      }
      return { error: { message: f.message } };
    }
    try {
      return { result: { result: { value: run(expr) } } };
    } catch (e) {
      return { result: { exceptionDetails: { text: e.message } } };
    }
  };
  app.page = () => {
    app.pagesOpened++;
    return {
      async send(method, params) {
        return evaluatePage(params.expression);
      },
      on() {},
      close() {
        app.pagesClosed++;
      },
    };
  };
  app.main = {
    async send(method, params) {
      const expr = params.expression;
      if (expr.includes("__mtperf.log.filter")) {
        const since = Number(expr.match(/e\[0\] >= (\d+)/)[1]);
        return { result: { result: { value: app.screen.filter((e) => e[0] >= since) } } };
      }
      return { result: { result: { value: 1 } } };
    },
    close() {},
  };
  app.inst = {
    async waitLog(re, sinceMs) {
      return app.log.find((l) => l.t >= sinceMs - 50 && re.test(l.s)) ?? null;
    },
  };
  return app;
}

function driverFor(app) {
  const driver = new Driver(app.inst);
  driver.main = app.main;
  driver.page = async () => app.page();
  return driver;
}

describe("perf driver when a page's context is replaced (#895)", () => {
  it("tells a lost context from other errors", () => {
    expect(isContextLost(new Error(NotFound))).toBe(true);
    expect(isContextLost(new Error(Destroyed))).toBe(true);
    expect(isContextLost(new Error("connection closed"))).toBe(true);
    expect(isContextLost(new Error("ReferenceError: WOS is not defined"))).toBe(false);
    expect(neverRan(new Error(NotFound))).toBe(true);
    expect(neverRan(new Error(Destroyed))).toBe(false);
  });

  it("evaluates in the main process's default context, not its internal one", async () => {
    let listener = null;
    const sent = [];
    const client = {
      on(fn) {
        listener = fn;
      },
      async send(method, params) {
        sent.push({ method, params });
        if (method === "Runtime.enable") {
          listener({
            method: "Runtime.executionContextCreated",
            params: { context: { id: 2, uniqueId: "internal", auxData: { isDefault: false } } },
          });
          listener({
            method: "Runtime.executionContextCreated",
            params: { context: { id: 1, uniqueId: "main", auxData: { isDefault: true } } },
          });
        }
        return method === "Runtime.evaluate" ? { result: { result: { value: 7 } } } : {};
      },
      close() {},
    };
    await pinDefaultContext(client);
    expect(await evaluate(client, "7")).toBe(7);
    expect(sent.map((s) => s.method)).toEqual(["Runtime.enable", "Runtime.disable", "Runtime.evaluate"]);
    expect(sent[2].params.uniqueContextId).toBe("main");
  });

  it("deletes a workspace when the context is replaced before the call", async () => {
    const app = fakeApp();
    const driver = driverFor(app);
    const created = await driver.create();
    app.faults.push({ match: "deleteWorkspace", message: NotFound });
    const r = await driver.remove(created.workspace);
    expect(r.ms).not.toBeNull();
    expect(app.calls.delete).toBe(1);
    expect(app.workspaces.map((w) => w.id)).toEqual(["ws-1"]);
    expect(app.pagesClosed).toBe(app.pagesOpened);
  });

  it("does not delete twice when the context is replaced after the call ran", async () => {
    const app = fakeApp();
    const driver = driverFor(app);
    const created = await driver.create();
    app.faults.push({ match: "deleteWorkspace", message: Destroyed, after: true });
    const r = await driver.remove(created.workspace);
    expect(r.ms).not.toBeNull();
    expect(app.calls.delete).toBe(1);
    expect(app.pagesClosed).toBe(app.pagesOpened);
  });

  it("creates exactly one workspace whether the lost call ran or not", async () => {
    const app = fakeApp();
    const driver = driverFor(app);
    app.faults.push({ match: "createWorkspace", message: NotFound });
    const a = await driver.create();
    app.faults.push({ match: "createWorkspace", message: Destroyed, after: true });
    const b = await driver.create();
    expect(app.calls.create).toBe(2);
    expect([a.workspace, b.workspace]).toEqual(["ws-2", "ws-3"]);
    expect(a.ms).not.toBeNull();
    expect(b.ms).not.toBeNull();
  });

  it("switches once when the context is replaced around the call", async () => {
    const app = fakeApp();
    const driver = driverFor(app);
    await driver.create();
    app.faults.push({ match: "switchWorkspace", message: Destroyed, after: true });
    const r = await driver.switchTo("ws-1");
    expect(r.ms).not.toBeNull();
    expect(app.calls.switch).toBe(1);
  });

  it("reads again on a replaced context", async () => {
    const app = fakeApp();
    const driver = driverFor(app);
    app.faults.push({ match: "globalAtoms.workspace", message: Destroyed });
    app.faults.push({ match: "GetWorkspace", message: NotFound });
    expect(await driver.currentWorkspace()).toBe("ws-1");
    expect((await driver.listWorkspaces()).map((w) => w.id)).toEqual(["ws-1"]);
  });

  it("still fails on any other error, and on a context that never comes back", async () => {
    const app = fakeApp();
    const driver = driverFor(app);
    await expect(driver.pageEval("throwsReferenceError")).rejects.toThrow(/ReferenceError/);
    expect(app.pagesOpened).toBe(1);
    for (let i = 0; i < 10; i++) {
      app.faults.push({ match: "deleteWorkspace", message: NotFound });
    }
    await expect(driver.remove("ws-1")).rejects.toThrow(NotFound);
    expect(app.calls.delete).toBe(0);
  });
});
