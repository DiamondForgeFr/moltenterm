// The MoltenTerm part of test-band: `molten test-results show [--title <title>]` shows the output piped into it in a
// box next to the terminal it ran in, with a copy button. The Claude Code part (agents/claude-code/) runs it when a
// test run fails, through $.process.run; the command works the same from a shell.

const Usage = "usage: <test output> | molten test-results show [--title <title>]";

function parseShowArgs(args) {
    let title = "Failing tests";
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--title" && i + 1 < args.length) {
            title = args[i + 1];
            i++;
            continue;
        }
        return { error: `unknown argument "${args[i]}"` };
    }
    return { title };
}

export function activate(api) {
    api.commands.register(
        "test-results",
        ({ args, stdin, blockId }) => {
            if (args[0] !== "show") {
                return { output: Usage, exitCode: 2 };
            }
            const { title, error } = parseShowArgs(args.slice(1));
            if (error != null) {
                return { output: `molten test-results: ${error}\n${Usage}`, exitCode: 2 };
            }
            const text = (stdin ?? "").replace(/\n$/, "");
            if (text === "") {
                return { output: `molten test-results: nothing to show: pipe the output in\n${Usage}`, exitCode: 1 };
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
        { description: "show a test run's output in a box next to the terminal (test-band's Claude Code part runs it)" }
    );
}
