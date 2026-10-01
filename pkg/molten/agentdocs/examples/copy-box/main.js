// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The copy box, Moltenterm's first morph (FR-MORPH-007) and the reference example of a mod. It is written exactly
// like a user mod: one ES module, no import, only the MoltenApi it receives in activate.
//
//   molten copy [--title <title>] <text...>
//   <command> | molten copy [--title <title>]
//
// Coding agents use it for every piece of text the user has to copy: a token, a command, a URL.

// `--title` may come anywhere before the text; `--` ends the options, so a text may start with "--".
export function parseCopyArgs(args) {
    let title = "Copy";
    const words = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            words.push(...args.slice(i + 1));
            break;
        }
        if (arg === "--title" && i + 1 < args.length) {
            title = args[++i];
            continue;
        }
        if (arg.startsWith("--title=")) {
            title = arg.slice("--title=".length);
            continue;
        }
        words.push(arg);
    }
    return { title, text: words.join(" ") };
}

// Shells end piped text with one newline the user did not mean to copy; any other newline is kept.
export function textFromStdin(stdin) {
    if (stdin == null) {
        return "";
    }
    if (stdin.endsWith("\r\n")) {
        return stdin.slice(0, -2);
    }
    if (stdin.endsWith("\n")) {
        return stdin.slice(0, -1);
    }
    return stdin;
}

export function activate(api) {
    api.commands.register(
        "copy",
        ({ args, stdin, blockId }) => {
            const { title, text: argText } = parseCopyArgs(args);
            const text = argText !== "" ? argText : textFromStdin(stdin);
            if (text === "") {
                return { output: "molten copy: nothing to copy: give a text or pipe one", exitCode: 1 };
            }
            api.boxes.show({
                blockId,
                title,
                text,
                monospace: true,
                actions: [
                    {
                        icon: "copy",
                        label: "Copy",
                        run: async () => {
                            await api.clipboard.writeText(text);
                            return "Copied";
                        },
                    },
                ],
            });
            return "";
        },
        { description: "show text in a box with a copy button: molten copy [--title <title>] <text>, or pipe it" }
    );
}
