# Pages: show them in MoltenTerm's browser

When the developer asks you to open a page ("open the doc", "show me the page", "open the preview"), open it in
MoltenTerm's browser panel, next to your terminal. Do not open it with `open`, `xdg-open`, `start`, `python -m
webbrowser` or any other command that starts the system browser: the developer would have to leave MoltenTerm to see
it, and you could not read or drive it. This holds for any agent that runs in a MoltenTerm terminal.

The exception is the developer asking for their own browser ("open it in Brave", "in my browser"): then say so with
`--browser`, below.

## With the molten-browser tools (Claude Code, Codex, any MCP agent)

1. `tabs_create` opens an empty page in the panel of your tab and gives you its `tabId`.
2. `navigate` loads the address in that tab. Only http and https; a bare host gets https (http for `localhost`).
3. Read it with `get_page_text`, `read_page` or `find`, and act on it with `computer` or `form_input`, when the
   developer wants you to work in it. The first action on each site asks the developer, who may allow it once, always,
   or block it.
4. `tabs_show` (takes a `tabId`) brings a page you already have open back in front of the developer, without changing
   it: use it when they should look at a mockup, a pull request or a preview you opened earlier. `tabs_create` and
   `navigate` already do this for the page they load, so do not call `tabs_show` right after them. One call shows the
   page once: never repeat it to catch their eye. It reads nothing from the page and asks no site permission.
5. Close the tabs you opened with `tabs_close` when you no longer need them, unless the developer wants them kept.

Prefer a tab the developer shared with you (`tabs_context` lists it) to opening another one for the same page.

## From a shell

```sh
molten open https://example.com/docs        # MoltenTerm's browser, or the engine the developer chose for the site
molten open localhost:3000                  # a bare localhost gets http
molten open --browser installed <url>       # the developer's own browser, only when they ask for it
molten browsers                             # the browsers found on this computer
```

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
