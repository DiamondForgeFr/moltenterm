// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The launcher's tables against the help text of the Codex version they were read on (#990, TC-SHELL-038-12).

const codexHelpFixture = "codex-0.163.0-help.txt"

// Codex's subcommands that start a session in the pane: the launcher integrates them.
var codexIntegratedSubcommands = map[string]bool{"exec": true, "e": true, "review": true, "resume": true, "fork": true}

// Subcommands of the table that the 0.163.0 help does not list: hidden ones, and older versions'.
var codexUnlistedSubcommands = map[string]bool{
	"execpolicy": true, "responses-api-proxy": true, "stdio-to-uds": true, "mcp-server": true, "generate-ts": true,
}

var (
	codexHelpCommandRe = regexp.MustCompile(`^  ([a-z][a-z0-9-]*)\s{2,}`)
	codexHelpAliasRe   = regexp.MustCompile(`\[aliases: ([^\]]+)\]`)
	codexHelpOptionRe  = regexp.MustCompile(`^\s+(?:(-[A-Za-z]), )?(--[a-z0-9-]+)(?: <[^>]+>(\.\.\.)?)?\s*$`)
)

type codexHelp struct {
	subcommands map[string]bool
	// options: every option name, short and long, with whether it takes a value; greedy: it takes several.
	options map[string]bool
	greedy  map[string]bool
}

func readCodexHelp(t *testing.T) codexHelp {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", codexHelpFixture))
	if err != nil {
		t.Fatalf("read the help text: %v", err)
	}
	rtn := codexHelp{subcommands: map[string]bool{}, options: map[string]bool{}, greedy: map[string]bool{}}
	section := ""
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasSuffix(line, ":") && !strings.HasPrefix(line, " ") {
			section = strings.TrimSuffix(line, ":")
			continue
		}
		switch section {
		case "Commands":
			if m := codexHelpCommandRe.FindStringSubmatch(line); m != nil {
				rtn.subcommands[m[1]] = true
			}
			if m := codexHelpAliasRe.FindStringSubmatch(line); m != nil {
				for _, alias := range strings.Split(m[1], ",") {
					rtn.subcommands[strings.TrimSpace(alias)] = true
				}
			}
		case "Options":
			m := codexHelpOptionRe.FindStringSubmatch(line)
			if m == nil {
				continue
			}
			takesValue := strings.Contains(line, "<")
			for _, name := range []string{m[1], m[2]} {
				if name == "" {
					continue
				}
				rtn.options[name] = takesValue
				if m[3] != "" {
					rtn.greedy[name] = true
				}
			}
		}
	}
	if len(rtn.subcommands) < 20 || len(rtn.options) < 20 {
		t.Fatalf("the help text was not parsed: %d subcommands, %d options", len(rtn.subcommands), len(rtn.options))
	}
	return rtn
}

func sortedKeys(m map[string]bool) []string {
	var rtn []string
	for k := range m {
		rtn = append(rtn, k)
	}
	sort.Strings(rtn)
	return rtn
}

func TestCodexSubcommandsAgainstHelp(t *testing.T) {
	help := readCodexHelp(t)
	for _, name := range sortedKeys(help.subcommands) {
		if codexSubcommands[name] == codexIntegratedSubcommands[name] {
			t.Errorf("codex %s: must be either passed through or integrated", name)
		}
	}
	for _, name := range sortedKeys(codexSubcommands) {
		if !help.subcommands[name] && !codexUnlistedSubcommands[name] {
			t.Errorf("codex %s is in the table but not in the 0.163.0 help", name)
		}
	}
	for _, name := range []string{"agents", "plugin", "remote-control", "update", "doctor", "queue", "archive", "delete",
		"migrate-rollouts", "unarchive", "exec-server"} {
		if !(codexAdapter{}).PassThrough([]string{name}) {
			t.Errorf("codex %s: passed through", name)
		}
		if !(codexAdapter{}).PassThrough([]string{"-m", "o3", name}) {
			t.Errorf("codex -m o3 %s: passed through", name)
		}
	}
	for name := range codexIntegratedSubcommands {
		if (codexAdapter{}).PassThrough([]string{name}) {
			t.Errorf("codex %s starts a session: integrated", name)
		}
	}
}

func TestCodexOptionsAgainstHelp(t *testing.T) {
	help := readCodexHelp(t)
	for _, name := range sortedKeys(help.options) {
		takesValue := help.options[name]
		if help.greedy[name] {
			if !codexGreedyOptions[name] {
				t.Errorf("%s takes several values: in codexGreedyOptions", name)
			}
			continue
		}
		if codexValueOptions[name] != takesValue {
			t.Errorf("%s: takes a value %v in the help, %v in codexValueOptions", name, takesValue, codexValueOptions[name])
		}
	}
	for _, name := range sortedKeys(codexValueOptions) {
		if _, ok := help.options[name]; !ok {
			t.Errorf("%s is in codexValueOptions but not in the 0.163.0 help", name)
		}
	}
	for _, name := range sortedKeys(codexPassThroughFlags) {
		if _, ok := help.options[name]; !ok {
			t.Errorf("%s is a pass-through flag but not in the 0.163.0 help", name)
		}
	}
}
