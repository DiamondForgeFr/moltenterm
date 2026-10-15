# Language pack: translate MoltenTerm, or change one of its translations

This is a preconfigured morph. Follow it when the user asks to translate MoltenTerm into a language, to complete a
translation ("complete the Español (es) translation of MoltenTerm"), or to change some of MoltenTerm's texts in any
language, English and French included.

MoltenTerm ships English and French. Any other language is a **language pack**: a mod that holds data only, a
dictionary per language and a manifest, and no code. MoltenTerm reads it as JSON and never runs anything from it, so
enabling it asks for no trust. Its texts are shown as plain text, never as HTML.

## What a pack contains

```
<config>/mods/<id>/
    mod.json
    locales/es.json
```

```json
{
  "id": "lang-es",
  "name": "Spanish language pack",
  "version": "0.1.0",
  "description": "MoltenTerm's interface in Spanish",
  "apiVersion": 1,
  "languages": [{ "code": "es", "name": "Español", "file": "locales/es.json" }]
}
```

- `code`: a BCP 47 language code, optionally with a region (`es`, `pt-br`). `en` or `fr` overrides MoltenTerm's own
  texts for that language, key by key.
- `name`: the language's own name, as the language picker shows it (`Español`, `Deutsch`, `日本語`).
- A pack has no `main` and no `agents`: a manifest with `languages` and `main` is refused.

The dictionary has the shape of MoltenTerm's English one: nested objects of strings, addressed by dotted keys
(`shell.rail.newWorkspace`). It may hold only some keys: every key it lacks, and every empty string, shows English.

## Rules for the translation

- Keep every placeholder exactly: `{count}`, `{name}`, `{app}`… must appear in the translation, with the same names,
  and no other. A pack where one key breaks this is refused whole, and the message names the key and the placeholder.
- Keys English does not have are ignored, with a warning.
- Never translate the names of commands, settings and files (`molten mod disable`, `app:language`, `settings.json`),
  keyboard keys, or product names (MoltenTerm, Claude Code, GitHub).
- Keep the tone short and plain, as in English; use the language's usual typography (French puts a space before `:`).
- Do not name the user's machine or OS in a text unless English does ("this computer" stays as neutral as English).
- `molten` itself stays English: never try to translate command output.

## Which language to change

A request to change some texts ("rename the Tips entry") without naming a language targets the language the
interface speaks now: the `interface language:` line of `molten i18n status` (`active` with `--json`). It is the
`app:language` setting, or the system's language when that is not set, so it may not be English. An `en` pack does
nothing while the interface speaks French, and the reverse. Change that language, and tell the user which one you
changed; change other languages only when asked.

## Steps

1. `molten i18n status` lists the languages, where each comes from, and how many strings each lacks; its first line
   gives the interface language.
2. Find an existing pack for the language with `molten mod list --json` (its `languages` field). Edit that pack rather
   than creating a second one: two packs for one language are allowed, but only the most recently enabled is used.
3. A new language: `molten mod new lang-<code> --language <code> --language-name "<own name>"`. It prints the folder
   and the dictionary file to write.
4. Get the strings:
   - `molten i18n export --json` gives every English key with its placeholders (`keys[].placeholders`); without
     `--json` it prints the English dictionary itself, the shape the pack file takes.
   - To complete a pack: `molten i18n export --lang <code> --missing` prints, in English, only the keys the
     language still lacks. Translate them and merge them into the existing file; keep what is there.
   - To change one translation of a shipped language: `molten i18n export --lang fr --json` shows the current text of
     each key; the pack then holds only the keys to change.
5. Write the dictionary. It is large: write it in parts if needed, and keep it valid JSON.
6. Check it: `molten i18n check <file>` (or `molten mod validate <id>`). Fix every error it names, until it says ok.
   Missing strings are allowed (they show English); say how many remain.
7. Enable it: `molten mod enable <id>` (no trust prompt for a pack). A pack already enabled reloads by itself when
   its file is saved.
8. A saved file reloads the pack within about a second; then `molten i18n status` must show the language with the expected count, and `molten mod list` the pack `active`.
9. Report: tell the user the language now appears in Settings > General > Language under its own name (or that the
   change applies at once when that language is the interface language), how many strings remain in English if any,
   that `molten undo` reverts the last change and `molten mod disable <id>` turns the pack off.

When MoltenTerm is updated and adds strings, it tells the user how many are not translated in their language and
offers the request that completes it: follow the "complete" path above.
