// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"path/filepath"
	"regexp"
	"strings"
)

// The commands an agent used (FR-SHELL-084, #1188): the programs its main session ran in a shell, by name ("gh",
// "go"), in the order it first ran them. The agent window lists them. Provider-agnostic: each adapter hands the
// command line of its shell tool (Claude Code's Bash, Codex's shell calls) to NoteShellCommand; nothing else of the
// line is kept.

const (
	maxCommands       = 24
	maxCommandNameLen = 40
)

// Codex's function calls that run a shell command.
var codexShellTools = map[string]bool{"shell": true, "exec_command": true, "shell_command": true, "container.exec": true}

// Words that run or wrap another program, or open a block: the program after them is the one named.
var commandPrefixes = map[string]bool{
	"sudo": true, "env": true, "time": true, "nice": true, "nohup": true, "exec": true, "command": true, "xargs": true,
	"do": true, "then": true, "else": true, "!": true, "{": true,
}

// A segment starting with one of these runs no program of its own.
var shellBuiltins = map[string]bool{
	"cd": true, "export": true, "set": true, "unset": true, "source": true, ".": true, "true": true, "false": true,
	"exit": true, "echo": true, "printf": true, "test": true, "[": true, "[[": true, "if": true, "fi": true,
	"for": true, "done": true, "while": true, "until": true, "case": true, "esac": true, "local": true, "return": true,
	"pushd": true, "popd": true, "wait": true, "trap": true, "read": true, "}": true,
}

// "2>&1", ">&2", "&>": redirections, whose & does not end a command.
var redirection = regexp.MustCompile(`\d*[<>]&\d*|&>`)

// A program's name: what a person would recognise as one (gh, go, moltenterm-check-ledger.mjs). Anything else is a
// fragment of a script, a jq program or a comment (#1543: "#\", ".number", "[\" showed in the agent window).
var programName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._+-]*$`)

// "<<EOF", "<<-'EOF'", `<< "END"`: a heredoc, whose body is data, not commands.
var heredocStart = regexp.MustCompile(`<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?`)

// quotedPlaceholder stands for a quoted string: its content is an argument, never a command, and the separators it
// holds (a newline, a '|' of a jq program) split nothing.
const quotedPlaceholder = "\x00"

// commandNames reads the programs a shell line runs, in order, each once.
func commandNames(line string) []string {
	var rtn []string
	seen := map[string]bool{}
	line = blankQuotes(dropHeredocs(line))
	line = redirection.ReplaceAllString(line, " ")
	segments := strings.FieldsFunc(line, func(r rune) bool {
		return r == '\n' || r == ';' || r == '|' || r == '&' || r == '(' || r == ')' || r == '`'
	})
	for _, seg := range segments {
		name := segmentProgram(seg)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		rtn = append(rtn, name)
	}
	return rtn
}

func segmentProgram(segment string) string {
	for _, word := range strings.Fields(segment) {
		word = strings.Trim(word, `"'`)
		if word == "" || strings.HasPrefix(word, "-") {
			continue
		}
		if isEnvAssignment(word) || commandPrefixes[word] {
			continue
		}
		if shellBuiltins[word] || strings.HasPrefix(word, "$") || strings.ContainsAny(word, "<>=*{}"+quotedPlaceholder) {
			return ""
		}
		name := filepath.Base(word)
		if len(name) > maxCommandNameLen || !programName.MatchString(name) {
			return ""
		}
		return name
	}
	return ""
}

// dropHeredocs removes the bodies of a line's heredocs, up to their closing word.
func dropHeredocs(line string) string {
	if !strings.Contains(line, "<<") {
		return line
	}
	var kept []string
	end := ""
	for _, l := range strings.Split(line, "\n") {
		if end != "" {
			if strings.TrimSpace(l) == end {
				end = ""
			}
			continue
		}
		kept = append(kept, l)
		if m := heredocStart.FindStringSubmatch(l); m != nil {
			end = m[1]
		}
	}
	return strings.Join(kept, "\n")
}

// blankQuotes replaces each quoted string by quotedPlaceholder and drops comments (a '#' that starts a word, outside
// quotes, to the end of its line). An unclosed quote runs to the end of the line.
func blankQuotes(line string) string {
	if !strings.ContainsAny(line, `'"#`) {
		return line
	}
	var b strings.Builder
	var quote byte
	for i := 0; i < len(line); i++ {
		c := line[i]
		if quote == 0 {
			if c == '#' && (i == 0 || strings.IndexByte(" \t\n;|&(", line[i-1]) >= 0) {
				for i < len(line) && line[i] != '\n' {
					i++
				}
				if i < len(line) {
					b.WriteByte('\n')
				}
				continue
			}
			if c == '\'' || c == '"' {
				quote = c
				b.WriteString(quotedPlaceholder)
				continue
			}
			b.WriteByte(c)
			continue
		}
		if c == '\\' && quote == '"' {
			i++
			continue
		}
		if c == quote {
			quote = 0
		}
	}
	return b.String()
}

func isEnvAssignment(word string) bool {
	eq := strings.IndexByte(word, '=')
	if eq <= 0 {
		return false
	}
	for i, r := range word[:eq] {
		ok := r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return false
		}
	}
	return true
}

// NoteShellCommand keeps the programs a shell call of the main agent runs.
func (s *Session) NoteShellCommand(line string) {
	for _, name := range commandNames(line) {
		if containsString(s.commands, name) {
			s.commandCounts[name]++
			continue
		}
		if len(s.commands) >= maxCommands {
			continue
		}
		if s.commandCounts == nil {
			s.commandCounts = map[string]int{}
		}
		s.commands = append(s.commands, name)
		s.commandCounts[name] = 1
	}
}

// CommandCounts tells how many shell calls ran each program of Commands.
func (s *Session) CommandCounts() map[string]int {
	if len(s.commandCounts) == 0 {
		return nil
	}
	rtn := make(map[string]int, len(s.commandCounts))
	for k, v := range s.commandCounts {
		rtn[k] = v
	}
	return rtn
}

// Commands lists the programs the main agent ran, in the order it first ran them.
func (s *Session) Commands() []string {
	if len(s.commands) == 0 {
		return nil
	}
	return append([]string(nil), s.commands...)
}

func containsString(list []string, value string) bool {
	for _, v := range list {
		if v == value {
			return true
		}
	}
	return false
}

// shellLine reads the command line of a shell tool's input: a string, or the words of an argv ("bash -lc <script>"
// gives its script).
func shellLine(input map[string]any) string {
	for _, key := range []string{"command", "cmd"} {
		switch v := input[key].(type) {
		case string:
			return v
		case []any:
			return shellWords(v)
		}
	}
	return ""
}
