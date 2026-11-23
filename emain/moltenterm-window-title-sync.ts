// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The system's window list tells windows apart by the window's own title (FR-SHELL-158, #2476): "MoltenTerm — DiamondForge -
// Terminal". The window is a BaseWindow, which takes no title from the page it shows, so the page's title (the shell
// writes the application, the context and the tab, frontend/moltenterm-shell/window-title.ts) is given to the window
// whenever the view on screen sets it, and when a view comes on screen.

export type TitledWindow = { setTitle: (title: string) => void; activeTabView: unknown };

export type TitledView = {
    webContents: {
        getTitle: () => string;
        on: (event: "page-title-updated", listener: (event: { preventDefault: () => void }, title: string) => void) => unknown;
    };
};

const Followed = new WeakSet<object>();

// A page that has not set a title yet answers "", which the window must not take: it keeps the title it has.
export function titleToShow(pageTitle: string): string {
    return typeof pageTitle === "string" ? pageTitle.trim() : "";
}

// The window shows the view's title now, and again each time the view sets it while it is the view on screen. windowOf
// finds the window a view belongs to when its title changes, since a view is moved between windows by nothing but its
// own switch.
export function followPageTitle<V extends TitledView, W extends TitledWindow>(
    win: W,
    view: V,
    windowOf: (view: V) => W | null | undefined
): void {
    // A view whose page is gone throws on every call: it has no title to give.
    const contents = view?.webContents;
    if (typeof contents?.getTitle !== "function" || typeof contents.on !== "function") {
        return;
    }
    try {
        const now = titleToShow(contents.getTitle());
        if (now) {
            win.setTitle(now);
        }
        if (Followed.has(view)) {
            return;
        }
        Followed.add(view);
        listenToPageTitle(view, windowOf);
    } catch (e) {
        console.log("followPageTitle: the view's page is gone", e);
    }
}

function listenToPageTitle<V extends TitledView, W extends TitledWindow>(
    view: V,
    windowOf: (view: V) => W | null | undefined
) {
    view.webContents.on("page-title-updated", (e, title) => {
        // The page's title is the window's: Electron's own default (the page's URL or the application's name) is not.
        e.preventDefault();
        const owner = windowOf(view);
        const text = titleToShow(title);
        if (owner != null && owner.activeTabView === view && text) {
            owner.setTitle(text);
        }
    });
}
