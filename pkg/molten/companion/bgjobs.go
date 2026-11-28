// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"path"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/jobline"
)

// What a background command is, in plain words (#2502, FR-SHELL-018): the sub-agent's command line is read only to
// name its job. A command is named by the program it starts, after `cd`, environment variables and the wrappers that
// only run another program (time, nohup, caffeinate, bash -c...); one that is none of the known ones is JobCommand. The
// line itself is never kept: only the kind and, for an npm script, the script's name. The reading itself is
// pkg/molten/jobline's, which the main session's background commands share (#2583).

const maxJobArgLength = 40

// An npm script's name is one word of these.
var jobScriptName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_.-]*$`)

// classifyBackgroundCommand names what a command line starts, in the molten.Job* kinds.
func classifyBackgroundCommand(command string) (string, string) {
	for _, segment := range jobline.Segments(command) {
		if kind, arg, ok := classifySegment(segment); ok {
			return kind, arg
		}
	}
	return molten.JobCommand, ""
}

func classifySegment(segment jobline.Segment) (string, string, bool) {
	words := segment.Words
	if strings.Contains(segment.Text, "moltenterm-affected") {
		return molten.JobAffected, "", true
	}
	program := path.Base(words[0])
	switch {
	case program == "vitest":
		return molten.JobVitest, "", true
	case jobline.IsRunner(program):
		rest := jobline.SkipFlags(words[1:])
		if len(rest) > 0 && path.Base(rest[0]) == "vitest" {
			return molten.JobVitest, "", true
		}
		return "", "", false
	case program == "go":
		rest := jobline.SkipFlags(words[1:])
		if len(rest) > 0 && rest[0] == "test" {
			return molten.JobGoTest, "", true
		}
	case program == "task":
		return classifyTask(jobline.SkipFlags(words[1:]))
	case program == "npm" || program == "pnpm" || program == "yarn" || program == "bun":
		return classifyNpm(program, jobline.SkipFlags(words[1:]))
	case program == "molten":
		rest := jobline.SkipFlags(words[1:])
		if len(rest) > 0 && rest[0] == "ci" {
			return molten.JobMoltenCi, "", true
		}
	}
	return "", "", false
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
		words = jobline.SkipFlags(words[1:])
	case "exec", "x":
		rest := jobline.SkipFlags(words[1:])
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
