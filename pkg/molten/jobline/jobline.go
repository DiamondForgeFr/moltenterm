// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package jobline reads the command line of a background command in plain words (#2502, #2583, FR-CONT-015): which
// program each of its segments starts, and whether the command is a service, a program that runs until somebody stops
// it. The line is read once and never kept.
//
// It imports the standard library only, and compiles no regular expression at start: the molten program's hooks
// (pkg/molten/agenthook) classify a background command as they report it, and every hook run starts what they link.
package jobline

import (
	"path"
	"strings"
)

// Segment is one command of a line: Text as written, Words the program it runs and its arguments, after the
// environment assignments and the wrappers that only run another program.
type Segment struct {
	Text  string
	Words []string
}

// The characters that end a command or open another inside one: a command line may be a script run through bash -c
// "cd x && npx vitest", and the named program is the first known one.
var separators = strings.NewReplacer(";", "\n", "|", "\n", "&", "\n", "(", "\n", ")", "\n", "{", "\n", "}", "\n", "\"", "\n", "'", "\n", "`", "\n", "$", "\n")

// wrappers are programs that only run the command that follows them (and flags before it).
var wrappers = map[string]bool{
	"time": true, "nice": true, "nohup": true, "caffeinate": true, "env": true, "exec": true, "sudo": true,
	"timeout": true, "command": true, "stdbuf": true, "bash": true, "sh": true, "zsh": true, "ionice": true,
}

// runners start the program named after them: npx vitest, pnpm exec vitest.
var runners = map[string]bool{"npx": true, "bunx": true, "pnpx": true}

// Segments reads a command line: the commands it runs, in order. A segment with no program (an empty one, a lone
// wrapper) is left out.
func Segments(line string) []Segment {
	var rtn []Segment
	for _, text := range strings.Split(separators.Replace(line), "\n") {
		words := programWords(strings.Fields(text))
		if len(words) > 0 {
			rtn = append(rtn, Segment{Text: text, Words: words})
		}
	}
	return rtn
}

// IsRunner tells whether a program only starts the one named after it (npx, bunx, pnpx).
func IsRunner(program string) bool {
	return runners[program]
}

// SkipFlags drops the flags that open a list of words.
func SkipFlags(words []string) []string {
	for len(words) > 0 && strings.HasPrefix(words[0], "-") {
		words = words[1:]
	}
	return words
}

// programWords drops the environment assignments and the wrappers before the program a segment runs.
func programWords(words []string) []string {
	for len(words) > 0 {
		word := words[0]
		switch {
		case isEnvAssignment(word):
			words = words[1:]
		case wrappers[path.Base(word)]:
			words = SkipFlags(words[1:])
			if len(words) > 0 && isNumberWord(words[0]) {
				words = words[1:]
			}
		default:
			return words
		}
	}
	return nil
}

// isEnvAssignment: a shell word that assigns an environment variable, FOO=bar.
func isEnvAssignment(word string) bool {
	for i := 0; i < len(word); i++ {
		c := word[i]
		switch {
		case c == '=':
			return i > 0
		case c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'):
		case c >= '0' && c <= '9' && i > 0:
		default:
			return false
		}
	}
	return false
}

func isNumberWord(word string) bool {
	if word == "" {
		return false
	}
	for _, r := range word {
		if (r < '0' || r > '9') && r != '.' && r != 's' && r != 'm' && r != 'h' {
			return false
		}
	}
	return true
}

// Services (#2583). A command is a service when one of its segments starts a program known to run until it is
// stopped; every other command is bounded work, which the agent resumes on when it ends. The list is explicit: no time
// bound (a CI wait runs past any), no word of the agent's (any language), no flag (`gh pr checks --watch` ends alone).
//
//	molten mcp ...                          MoltenTerm's own stdio servers (browser, review)
//	<program> daemon|serve|server           the program's first argument (`molten-browser.mjs daemon`, `hugo server`);
//	                                        a script's first argument after the script (`node x.mjs daemon`,
//	                                        `php artisan serve`)
//	python -m http.server
//	task dev|start|preview|...              the Taskfile's long-running tasks (serviceTasks)
//	npm|pnpm|yarn|bun run dev|start|serve|preview|watch   a script whose name has one of these as a part (dev:web)
//	vite (not build), next dev|start        also through npx, pnpm exec, yarn
//	tail -f
//
// IsService tells whether the command line starts one.
func IsService(line string) bool {
	for _, seg := range Segments(line) {
		if programService(seg.Words, 0, true) {
			return true
		}
	}
	return false
}

// maxServiceDepth bounds the runners a program is looked through: npx pnpm exec vite.
const maxServiceDepth = 4

// serviceTasks: the Taskfile's tasks that run until stopped (`dev` and `start` are aliases of the Electron ones).
var serviceTasks = map[string]bool{
	"dev": true, "start": true, "preview": true, "docsite:start": true,
	"electron:dev": true, "electron:start": true, "electron:quickdev": true, "electron:winquickdev": true,
}

// programService: words[0] is the program. generic: the program's first argument may name a daemon or a server when
// no rule above knows the program (not when a package manager only forwards a word it did not recognise).
func programService(words []string, depth int, generic bool) bool {
	if len(words) == 0 || depth > maxServiceDepth {
		return false
	}
	program := path.Base(words[0])
	args := words[1:]
	switch {
	case program == "molten":
		rest := SkipFlags(args)
		return len(rest) > 0 && rest[0] == "mcp"
	case program == "task":
		name, _ := subcommand(args)
		return serviceTasks[name]
	case program == "npm" || program == "pnpm" || program == "yarn" || program == "bun":
		return packageService(args, depth)
	case runners[program]:
		return programService(SkipFlags(args), depth+1, true)
	case program == "vite":
		name, _ := subcommand(args)
		return name != "build" && name != "optimize"
	case program == "next":
		name, _ := subcommand(args)
		return name == "dev" || name == "start"
	case program == "tail":
		return followsFile(args)
	case isInterpreter(program):
		return interpreterService(args)
	case !generic || takesPlainArguments(program):
		return false
	}
	return daemonWord(args)
}

// subcommand: the first word that is not a flag, and the words after it.
func subcommand(args []string) (string, []string) {
	args = SkipFlags(args)
	if len(args) == 0 {
		return "", nil
	}
	return args[0], args[1:]
}

func daemonWord(args []string) bool {
	name, _ := subcommand(args)
	return name == "daemon" || name == "serve" || name == "server"
}

// packageService reads the words of npm, pnpm, yarn and bun: a script of the package (npm run dev, yarn start, pnpm
// dev), or a program they start (pnpm exec vite, yarn vite).
func packageService(args []string, depth int) bool {
	cmd, rest := subcommand(args)
	switch cmd {
	case "":
		return false
	case "run", "run-script":
		script, _ := subcommand(rest)
		return serviceScript(script)
	case "exec", "x", "dlx":
		return programService(SkipFlags(rest), depth+1, true)
	}
	return serviceScript(cmd) || programService(append([]string{cmd}, rest...), depth+1, false)
}

// serviceScript: a script whose name has one of the words of a server as one of its colon-separated parts (dev,
// start:prod, build:watch).
func serviceScript(name string) bool {
	for _, part := range strings.Split(name, ":") {
		switch part {
		case "dev", "start", "serve", "preview", "watch":
			return true
		}
	}
	return false
}

// followsFile: tail's -f, -F and --follow, alone or in a cluster of flags (-fn 20); the words after -- are files.
func followsFile(args []string) bool {
	for _, word := range args {
		switch {
		case word == "--":
			return false
		case word == "--follow" || strings.HasPrefix(word, "--follow="):
			return true
		case strings.HasPrefix(word, "--"):
		case strings.HasPrefix(word, "-") && strings.ContainsAny(word[1:], "fF"):
			return true
		}
	}
	return false
}

func isInterpreter(program string) bool {
	switch program {
	case "node", "nodejs", "deno", "php", "ruby", "perl", "tsx", "ts-node":
		return true
	}
	return strings.HasPrefix(program, "python")
}

// interpreterService: the script an interpreter runs is its first argument, and the word of a daemon or a server is
// one of the first two words after it (node x.mjs daemon, node x.mjs --port 80 daemon: the flag's value is the first).
func interpreterService(args []string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-m" && args[i+1] == "http.server" {
			return true
		}
	}
	script, rest := subcommand(args)
	if script == "" {
		return false
	}
	for i, word := range SkipFlags(rest) {
		if i > 1 {
			return false
		}
		if word == "daemon" || word == "serve" || word == "server" {
			return true
		}
	}
	return false
}

// takesPlainArguments: programs whose first argument is a file, a folder or a text, which may be a folder named
// server: `cd server`, `grep daemon app.log`, `vitest server`.
func takesPlainArguments(program string) bool {
	switch program {
	case "cd", "ls", "cat", "head", "less", "more", "rm", "cp", "mv", "mkdir", "touch", "open", "code", "stat", "file",
		"find", "du", "tree", "wc", "chmod", "diff", "echo", "printf", "grep", "egrep", "fgrep", "rg", "ag", "sed",
		"awk", "man", "which", "type", "sleep", "vitest", "jest", "eslint", "prettier", "tsc", "go", "cargo", "git", "gh":
		return true
	}
	return false
}
