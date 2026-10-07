// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"strings"
	"testing"
)

func TestMoltenTaskRouting(t *testing.T) {
	cases := map[string]string{
		"molten task":                     "task",
		"molten task --json":              "task",
		"molten task show":                "show",
		"molten task show --section Goal": "show",
		"molten task edit":                "edit",
		"molten task history --json":      "history",
		"molten task restore 2":           "restore",
		"molten task clear":               "clear",
	}
	for line, want := range cases {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil {
			t.Fatalf("%q: %v", line, err)
		}
		if found.Name() != want {
			t.Errorf("%q routes to %q, want %q", line, found.Name(), want)
		}
	}
	help := formatMoltenHelp(nil)
	for _, want := range []string{"task show", "task edit", "task history", "task restore <n>", "task clear"} {
		if !strings.Contains(help, want) {
			t.Errorf("molten help lacks %q", want)
		}
	}
}
