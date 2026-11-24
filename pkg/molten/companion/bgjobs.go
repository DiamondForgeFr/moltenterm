// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"path"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What a background command is, in plain words (#2502, FR-SHELL-018): the sub-agent's command line is read only to
// name its job. A command is named by the program it starts, after `cd`, environment variables and the wrappers that
// only run another program (time, nohup, caffeinate, bash -c...); one that is none of the known ones is JobCommand. The
// line itself is never kept: only the kind and, for an npm script, the script's name.

const maxJobArgLength = 40

var (
	// A shell word that assigns an environment variable: FOO=bar.
	jobEnvAssignment = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	// The characters that end a command or open another inside one: a command line may be a script run through bash -c
	// "cd x && npx vitest", and the named program is the first known one.
	jobSeparators = strings.NewReplacer(";", "\n", "|", "\n", "&", "\n", "(", "\n", ")", "\n", "{", "\n", "}", "\n", "\"", "\n", "'", "\n", "`", "\n", "$", "\n")
	// An npm script's name is one word of these.
	jobScriptName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_.-]*$`)
)

// jobWrappers are programs that only run the command that follows them (and flags before it).
var jobWrappers = map[string]bool{
	"time": true, "nice": true, "nohup": true, "caffeinate": true, "env": true, "exec": true, "sudo": true,
	"timeout": true, "command": true, "stdbuf": true, "bash": true, "sh": true, "zsh": true, "ionice": true,
}

// jobPackageRunners start the program named after them: npx vitest, pnpm exec vitest.
var jobPackageRunners = map[string]bool{"npx": true, "bunx": true, "pnpx": true}

// classifyBackgroundCommand names what a command line starts, in the molten.Job* kinds.
func classifyBackgroundCommand(command string) (string, string) {
	for _, segment := range strings.Split(jobSeparators.Replace(command), "\n") {
		if kind, arg, ok := classifySegment(segment); ok {
			return kind, arg
		}
	}
	return molten.JobCommand, ""
}

func classifySegment(segment string) (string, string, bool) {
	words := jobProgramWords(strings.Fields(segment))
	if len(words) == 0 {
		return "", "", false
	}
	if strings.Contains(segment, "moltenterm-affected") {
		return molten.JobAffected, "", true
	}
	program := path.Base(words[0])
	switch {
	case program == "vitest":
		return molten.JobVitest, "", true
	case jobPackageRunners[program]:
		rest := jobSkipFlags(words[1:])
		if len(rest) > 0 && path.Base(rest[0]) == "vitest" {
			return molten.JobVitest, "", true
		}
		return "", "", false
	case program == "go":
		rest := jobSkipFlags(words[1:])
		if len(rest) > 0 && rest[0] == "test" {
			return molten.JobGoTest, "", true
		}
	case program == "task":
		return classifyTask(jobSkipFlags(words[1:]))
	case program == "npm" || program == "pnpm" || program == "yarn" || program == "bun":
		return classifyNpm(program, jobSkipFlags(words[1:]))
	case program == "molten":
		rest := jobSkipFlags(words[1:])
		if len(rest) > 0 && rest[0] == "ci" {
			return molten.JobMoltenCi, "", true
		}
	}
	return "", "", false
}

// jobProgramWords drops the environment assignments and the wrappers before the program a segment runs.
func jobProgramWords(words []string) []string {
	for len(words) > 0 {
		word := words[0]
		switch {
		case jobEnvAssignment.MatchString(word):
			words = words[1:]
		case jobWrappers[path.Base(word)]:
			words = jobSkipFlags(words[1:])
			if len(words) > 0 && isNumberWord(words[0]) {
				words = words[1:]
			}
		default:
			return words
		}
	}
	return nil
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

func jobSkipFlags(words []string) []string {
	for len(words) > 0 && strings.HasPrefix(words[0], "-") {
		words = words[1:]
	}
	return words
}

// classifyTask names a Taskfile task by its name: task build:frontend, task build:server, task perf:bundle...
func classifyTask(words []string) (string, string, bool) {
	if len(words) == 0 {
		return "", "", false
	}
	name := words[0]
	switch {
	case strings.HasPrefix(name, "build:frontend"):
		return molten.JobBuildFrontend, "", true
	case strings.HasPrefix(name, "build:backend"), strings.HasPrefix(name, "build:server"), strings.HasPrefix(name, "build:wsh"), strings.HasPrefix(name, "build:molten"):
		return molten.JobBuildBackend, "", true
	case name == "build" || strings.HasPrefix(name, "build:") || name == "package" || strings.HasPrefix(name, "package:"):
		return molten.JobBuild, "", true
	case name == "perf" || strings.HasPrefix(name, "perf:"):
		return molten.JobPerf, "", true
	case strings.HasPrefix(name, "check:"):
		return molten.JobCheck, "", true
	case name == "test" || strings.HasPrefix(name, "test:"):
		return molten.JobTests, "", true
	}
	return "", "", false
}

// classifyNpm names a package manager's script: its test scripts are tests, the others an npm script of that name.
func classifyNpm(program string, words []string) (string, string, bool) {
	if len(words) == 0 {
		return "", "", false
	}
	switch words[0] {
	case "test", "t":
		return molten.JobTests, "", true
	case "run", "run-script":
		words = jobSkipFlags(words[1:])
	case "exec", "x":
		rest := jobSkipFlags(words[1:])
		if len(rest) > 0 && path.Base(rest[0]) == "vitest" {
			return molten.JobVitest, "", true
		}
		return "", "", false
	default:
		if program == "npm" {
			return "", "", false
		}
	}
	if len(words) == 0 || !jobScriptName.MatchString(words[0]) {
		return "", "", false
	}
	script := words[0]
	if script == "vitest" {
		return molten.JobVitest, "", true
	}
	if script == "test" || strings.HasPrefix(script, "test:") {
		return molten.JobTests, "", true
	}
	if len(script) > maxJobArgLength {
		script = script[:maxJobArgLength]
	}
	return molten.JobNpmRun, script, true
}
