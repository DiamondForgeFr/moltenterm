// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var codexHelpOptionRe = regexp.MustCompile(`^\s+(?:(-[A-Za-z]), )?(--[a-z0-9-]+)(?: <[^>]+>(\.\.\.)?)?\s*$`)

// Codex's option grammar against the help text of the version it was read on (#990); the launcher's own test reads
// the same file.
func TestCodexOptionGrammarAgainstHelp(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "agentlaunch", "testdata", "codex-0.163.0-help.txt"))
	if err != nil {
		t.Fatalf("read the help text: %v", err)
	}
	inOptions := false
	seen := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasSuffix(line, ":") && !strings.HasPrefix(line, " ") {
			inOptions = line == "Options:"
			continue
		}
		m := codexHelpOptionRe.FindStringSubmatch(line)
		if !inOptions || m == nil {
			continue
		}
		takesValue, greedy := strings.Contains(line, "<"), m[3] != ""
		for _, name := range []string{m[1], m[2]} {
			if name == "" {
				continue
			}
			seen[name] = true
			if greedy != codexOptionGrammar.greedy[name] || (!greedy && takesValue != codexOptionGrammar.value[name]) {
				t.Errorf("%s: value %v greedy %v in the help, not in codexOptionGrammar", name, takesValue, greedy)
			}
		}
	}
	if len(seen) < 20 {
		t.Fatalf("the help text was not parsed: %d options", len(seen))
	}
	for name := range codexOptionGrammar.value {
		if !seen[name] {
			t.Errorf("%s is in codexOptionGrammar but not in the 0.163.0 help", name)
		}
	}
}
