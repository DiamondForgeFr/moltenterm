import { describe, expect, it, vi } from "vitest";
import { runMenuSelection } from "../../moltenterm-shell/menu/menu-model";

async function setup() {
    vi.resetModules();
    const native = vi.fn();
    vi.doMock("./global", () => ({
        atoms: {},
        getApi: () => ({ showContextMenu: native, onContextMenuClick: vi.fn() }),
        globalStore: { get: vi.fn() },
    }));
    const { ContextMenuModel } = await import("./contextmenu");
    const model = ContextMenuModel.getInstance();
    const presenter = vi.fn();
    model.registerPresenter(presenter, () => false);
    return { model, presenter, native };
}
const Event = { stopPropagation: vi.fn(), preventDefault: vi.fn(), clientX: 20, clientY: 30 } as any;
describe("renderer context menu sessions", () => {
    it("runs original callbacks exactly once, ignoring stale native dismissal", async () => {
        const { model, presenter, native } = await setup();
        const order: string[] = [];
        const item = { label: "Open", click: () => order.push("click") };
        model.showContextMenu([item], Event, {
            onSelect: () => order.push("select"),
            onClose: () => order.push("close"),
        });
        const session = presenter.mock.calls[0][0];
        model.handleContextMenuClick(null);
        session.select(item);
        session.select(item);
        session.cancel();
        expect(order).toEqual(["click", "select", "close"]);
        expect(native).not.toHaveBeenCalled();
    });
    it("cancels replacement once and rejects stale selection", async () => {
        const { model, presenter } = await setup();
        const cancel = vi.fn();
        const close = vi.fn();
        const click = vi.fn();
        const first = { label: "First", click };
        model.showContextMenu([first], Event, { onCancel: cancel, onClose: close });
        const session = presenter.mock.calls[0][0];
        model.showContextMenu([{ label: "Second" }], Event);
        session.select(first);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledWith(null);
        expect(click).not.toHaveBeenCalled();
        expect(model.session.menu[0].label).toBe("Second");
    });
    it("clears state before reentrant selection and preserves new menu", async () => {
        const { model, presenter } = await setup();
        const item = { label: "First", click: () => model.showContextMenu([{ label: "Next" }], Event) };
        model.showContextMenu([item], Event);
        presenter.mock.calls[0][0].select(item);
        expect(model.session.menu[0].label).toBe("Next");
    });
    it("honors role precedence and closes after throwing callbacks", async () => {
        const { model, presenter } = await setup();
        const click = vi.fn();
        const role = vi.fn();
        const close = vi.fn();
        const item = { role: "copy", click };
        model.showContextMenu([item], Event, { onClose: close });
        presenter.mock.calls[0][0].select(item, role);
        expect(role).toHaveBeenCalledOnce();
        expect(click).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledWith(item);
        const boom = {
            click: () => {
                throw new Error("boom");
            },
        };
        const onSelect = vi.fn();
        model.showContextMenu([boom], Event, { onSelect, onClose: close });
        expect(() => presenter.mock.calls[2][0].select(boom)).toThrow("boom");
        expect(onSelect).toHaveBeenCalledWith(boom);
        expect(close).toHaveBeenLastCalledWith(boom);
        expect(model.session).toBeNull();
    });
    it("uses synchronous native opt-in and correlates dismissals", async () => {
        const { model, native } = await setup();
        model.useNative = () => true;
        const close = vi.fn();
        const item = { role: "copy" };
        model.showContextMenu([item], Event, { onClose: close });
        const [_, items, token] = native.mock.calls[0];
        model.handleContextMenuClick(null, "old-token");
        expect(close).not.toHaveBeenCalled();
        model.handleContextMenuClick(items[0].id, token);
        expect(close).toHaveBeenCalledWith(item);
    });
});

describe("presentation teardown", () => {
    it("cancels empty and all-hidden menus once", async () => {
        const { model } = await setup();
        const order: string[] = [];
        for (const menu of [[], [{ label: "Hidden", visible: false }]]) {
            model.showContextMenu(menu, Event, {
                onCancel: () => order.push("cancel"),
                onClose: () => order.push("close"),
            });
            expect(model.session).toBeNull();
        }
        expect(order).toEqual(["cancel", "close", "cancel", "close"]);
    });
    it("detaches the presenter before reentrant cancellation opens a fallback", async () => {
        const { model, native } = await setup();
        const unregister = model.registerPresenter(vi.fn(), () => false);
        model.showContextMenu([{ label: "First" }], Event, {
            onCancel: () => model.showContextMenu([{ label: "Next" }], Event),
        });
        unregister();
        expect(model.presenter).toBeNull();
        expect(model.native).toBe(true);
        expect(native).toHaveBeenCalledOnce();
        expect(model.session.menu[0].label).toBe("Next");
    });
});

describe("guest focus transfer during selection", () => {
    it("allows synchronous guest blur during restore, then resumes real blur cancellation", async () => {
        const { model, presenter } = await setup();
        const selecting = { current: false };
        const cancel = vi.fn();
        const role = vi.fn();
        const close = vi.fn();
        const cleanup = vi.fn();
        const item = { role: "selectAll" };
        model.showContextMenu([item], Event, { onCancel: cancel, onClose: close });
        const session = presenter.mock.calls[0][0];
        const blur = () => {
            if (!selecting.current) model.session?.cancel();
        };
        runMenuSelection(selecting, blur, () => session.select(item, role), cleanup);
        expect(cancel).not.toHaveBeenCalled();
        expect(role).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledWith(item);
        expect(cleanup).toHaveBeenCalledOnce();
        model.showContextMenu([item], Event, { onCancel: cancel });
        blur();
        expect(cancel).toHaveBeenCalledOnce();
        expect(model.session).toBeNull();
    });
    it("releases the focus guard and leases when an action throws", () => {
        const selecting = { current: false };
        const cleanup = vi.fn();
        expect(() =>
            runMenuSelection(
                selecting,
                () => {},
                () => {
                    throw Error("action failed");
                },
                cleanup
            )
        ).toThrow("action failed");
        expect(selecting.current).toBe(false);
        expect(cleanup).toHaveBeenCalledOnce();
    });
});
