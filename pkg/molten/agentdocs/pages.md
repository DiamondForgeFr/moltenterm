# Pages: show them in MoltenTerm's browser

When the developer asks you to open a page ("open the doc", "show me the page", "open the preview"), open it in
MoltenTerm's browser panel, next to your terminal. Do not open it with `open`, `xdg-open`, `start`, `python -m
webbrowser` or any other command that starts the system browser: the developer would have to leave MoltenTerm to see
it, and you could not read or drive it. This holds for any agent that runs in a MoltenTerm terminal.

The exception is the developer asking for their own browser ("open it in Brave", "in my browser"): then say so with
`--browser`, below.

## With the molten-browser tools (Claude Code, Codex, any MCP agent)

1. `tabs_context` lists what is already open: your own tabs and, under `otherPages`, the other pages open in the
   browser panels of this workspace (never another workspace's). Call it before opening a page.
2. `tabs_create` with the page's `url` opens it, or reuses a page that is already open (see "Reuse an open page"
   below), and gives you its `tabId`. Only http and https; a bare host gets https (http for `localhost`). Without a
   `url` it opens an empty page, which `navigate` then loads.
3. Read it with `get_page_text`, `read_page` or `find`, and act on it with `computer` or `form_input`, when the
   developer wants you to work in it. The first action on each site asks the developer, who may allow it once, always,
   or block it.
4. `tabs_show` (takes a `tabId`) brings a page you already have open back in front of the developer, without changing
   it: use it when they should look at a mockup, a pull request or a preview you opened earlier. `tabs_create` and
   `navigate` already do this for the page they load, so do not call `tabs_show` right after them. One call shows the
   page once: never repeat it to catch their eye. It reads nothing from the page and asks no site permission.
5. Close the tabs you opened with `tabs_close` when you no longer need them, unless the developer wants them kept.

Prefer a tab the developer shared with you (`tabs_context` lists it) to opening another one for the same page.

## Reuse an open page

The developer ends up with the same page open many times when an agent opens it each time it needs it. So
`tabs_create` with a `url` first looks for a page that is already open in this workspace at the same address, compared
without the case of the scheme and host, the default port, a trailing slash or a fragment (the query counts), and
reuses it:

- **Your own tab:** it is shown to the developer, like `tabs_show` does, and loaded again only with `reload: true`.
  The result says "reused tab N".
- **A tab the developer opened, beside your terminal:** MoltenTerm asks them on that tab's bar, "<your first name> would
  like to use this page", with Allow and Open another tab. The call waits for the answer. Allow hands you the tab, as
  their Share does: "reused tab N". Open another tab opens a new one for you: "opened tab N". Nothing is taken without
  the answer. With no answer within about a minute the result says "waiting for the developer": nothing was opened or
  taken, and the question is withdrawn; call `tabs_create` again to ask again, or pass `newTab: true`.
- **Another agent's tab, and a page in another tab of the workspace:** never reused. A new tab opens.
- **Several matches:** your own tab first, then the one in view, then the most recently used.
- **`newTab: true`** opens a new tab even when the page is open: use it only when you really need two copies, to
  compare two states or two sign-ins.

To refresh a page you already have, `navigate` to the address the tab shows (or to `reload`), or pass `reload: true` to
`tabs_create`. The site permissions are the usual ones: reusing your own tab reads nothing, loading it again asks the
site as `navigate` does.

`tabs_context` shows the pages of the workspace that are not yours under `otherPages`: whose they are (the developer's,
or another agent's), their state, where they are and, for a site you may use, their title and address, without
credentials and with secrets in the query masked. They have no `tabId`: you cannot read or act on them.

## From a shell

```sh
molten open https://example.com/docs        # MoltenTerm's browser, or the engine the developer chose for the site
molten open localhost:3000                  # a bare localhost gets http
molten open --new-tab <url>                 # another panel, even when the page is already open
molten open --browser installed <url>       # the developer's own browser, only when they ask for it
molten browsers                             # the browsers found on this computer
```

`molten open` reuses too: a page already open in a browser panel of your tab is brought into view instead of opened
again, and not loaded again. It shows the page and hands nothing to you: to read or act on it, use the browser tools.

Programs that read the `BROWSER` variable (`gh pr view --web`, `npm`, `python -m webbrowser`) already open their pages
in MoltenTerm in a local MoltenTerm terminal: it is set to MoltenTerm's own handler.

A `file:` or `data:` page (`molten open file:///…`, `wsh web open`) does not load until the developer confirms it in the
panel, which names the file: the page can run scripts next to their files. Ask for one only when the developer wants
that file, serve a build over `http://localhost` otherwise, and do not queue it again if they decline (the panel closes).

## What the developer sees

- The page opens as a panel to the right of your terminal, which keeps the keyboard focus. Nothing opens in another tab
  or workspace.
- In a 360 view, a page you open, navigate or show with `tabs_show` that is off-screen on the carpet is scrolled into
  view, so the developer sees what you show. The carpet only scrolls: the focus does not move and no view is switched.
  Reading, clicking or typing in the page never scrolls it.
- In a grid view, a page hidden behind a panel the developer magnified is brought out: the magnification ends. No
  panel is moved, resized or closed, and a page already in view changes nothing.
- The tab's bar says why the page came into view: "<your first name> is showing you this page", for a few seconds.
- The keyboard focus never moves, whether the developer is typing or not: the page comes into view beside what they
  are doing, and their keys keep reaching their terminal.
- A bar on the tab says you are controlling it; the developer can stop you or take over at any time.
