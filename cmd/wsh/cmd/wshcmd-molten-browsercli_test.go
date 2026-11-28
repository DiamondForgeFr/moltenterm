// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// The guard of #2596 on the command line's side: every tool of the molten-browser server has a command that exists, built
// from its definition, or is listed MCP-only with its reason (pkg/molten/mcpbrowser/cli_test.go checks the list itself).

func moltenCommandByWords(command string) *cobra.Command {
	found, rest, err := moltenCmd.Find(strings.Fields(command))
	if err != nil || found == moltenCmd || len(rest) != 0 {
		return nil
	}
	return found
}

// The tests that look commands up walk the program's own command tree, which cobra sorts and caches as it is read: they
// run one after the other, not in parallel.
func TestEveryToolOfTheServerHasItsCommandOrItsReason(t *testing.T) {
	seen := map[string]bool{}
	for _, b := range mcpbrowser.CliBindings() {
		seen[b.Tool] = true
		if b.Command == "" {
			if b.McpOnly == "" {
				t.Errorf("%s has neither a command nor a reason", b.Tool)
			}
			continue
		}
		cmd := moltenCommandByWords(b.Command)
		if cmd == nil || cmd.RunE == nil {
			t.Errorf("%s: the command `molten %s` does not exist", b.Tool, b.Command)
			continue
		}
		if b.Existing {
			continue
		}
		if cmd.Annotations[moltenBrowserToolAnnotation] != b.Tool {
			t.Errorf("`molten %s` is not built from the tool %s: %v", b.Command, b.Tool, cmd.Annotations)
		}
		for _, f := range b.Flags {
			flag := cmd.Flags().Lookup(f.Name)
			if flag == nil || flag.Value.Type() != "bool" || flag.Usage != mcpbrowser.CliUsage(b.Tool, f.Property) {
				t.Errorf("`molten %s --%s` must be the tool's own property %s, with its description: %+v", b.Command, f.Name, f.Property, flag)
			}
		}
		if cmd.Flags().Lookup("json") == nil {
			t.Errorf("`molten %s` has no --json", b.Command)
		}
	}
	for _, tool := range serverToolNamesOf(t) {
		if !seen[tool] {
			t.Errorf("the tool %s has no binding: give it a command or an MCP-only reason in mcpbrowser.CliBindings", tool)
		}
	}
}

func serverToolNamesOf(t *testing.T) []string {
	t.Helper()
	var names []string
	for _, tool := range mcpbrowser.BrowserSpec().Tools {
		names = append(names, tool.Name)
	}
	return names
}

func TestNoBrowserCommandWithoutABinding(t *testing.T) {
	want := map[string]bool{}
	for _, b := range mcpbrowser.CliBindings() {
		if strings.HasPrefix(b.Command, mcpbrowser.CliGroup+" ") && !b.Existing {
			want[strings.TrimPrefix(b.Command, mcpbrowser.CliGroup+" ")] = true
		}
	}
	for _, c := range moltenBrowserCmd.Commands() {
		if !want[c.Name()] {
			t.Errorf("`molten browser %s` is written by hand: it must be a binding of mcpbrowser.CliBindings, or it drifts from the tools", c.Name())
		}
		delete(want, c.Name())
	}
	for name := range want {
		t.Errorf("`molten browser %s` is bound and was not built", name)
	}
}

func TestBrowserCommandsTakeTheArgumentsOfTheirTools(t *testing.T) {
	cases := []struct {
		line string
		use  string
		ok   [][]string
		bad  [][]string
	}{
		{"browser list", "list", [][]string{{}}, [][]string{{"x"}}},
		{"browser open", "open <url|path>", [][]string{{"example.com"}}, [][]string{{}, {"a", "b"}}},
		{"browser read", "read [tab]", [][]string{{}, {"3"}}, [][]string{{"3", "4"}}},
		{"browser show", "show [tab]", [][]string{{}, {"3"}}, [][]string{{"3", "4"}}},
		{"browser close", "close <tab>", [][]string{{"3"}}, [][]string{{}, {"3", "4"}}},
	}
	for _, c := range cases {
		cmd := moltenCommandByWords(c.line)
		if cmd == nil {
			t.Errorf("no command %s", c.line)
			continue
		}
		if cmd.Use != c.use {
			t.Errorf("%s usage = %q, want %q", c.line, cmd.Use, c.use)
		}
		for _, args := range c.ok {
			if err := cmd.Args(cmd, args); err != nil {
				t.Errorf("%s %v: %v", c.line, args, err)
			}
		}
		for _, args := range c.bad {
			if err := cmd.Args(cmd, args); err == nil {
				t.Errorf("%s %v must be refused", c.line, args)
			}
		}
	}
	open := moltenCommandByWords("browser open")
	for _, flag := range []string{"new-tab", "reload"} {
		if open.Flags().Lookup(flag) == nil || open.Flags().Lookup(flag).DefValue != "false" {
			t.Errorf("open --%s: a page is reused unless asked otherwise", flag)
		}
	}
}

func TestBrowserCommandsRouteThroughMolten(t *testing.T) {
	for line, want := range map[string]string{
		"molten browser list":                 "list",
		"molten browser open example.com":     "open",
		"molten browser open --new-tab x.dev": "open",
		"molten browser read 3 --json":        "read",
		"molten browser close 3":              "close",
	} {
		found, _, err := rootCmd.Find(strings.Fields(line))
		if err != nil || found.Name() != want || found.Parent() != moltenBrowserCmd {
			t.Errorf("%q routes to %v (%v), want %q of molten browser", line, found, err, want)
		}
	}
	if !moltenIsBuiltinSubcommand("browser") {
		t.Errorf("molten --json browser list reaches the group")
	}
}

func TestMoltenHelpListsTheBrowserCommands(t *testing.T) {
	t.Parallel()
	help := formatMoltenHelp(nil)
	for _, want := range []string{"browser list", "browser open <url|path>", "browser read [tab]", "browser show [tab]", "browser close <tab>"} {
		if !strings.Contains(help, want) {
			t.Errorf("molten help misses %q", want)
		}
	}
}

func TestBrowserTargetSeparatesAddressesFromFiles(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	page := filepath.Join(dir, "my mockup.html")
	if err := os.WriteFile(page, []byte("<p>hi</p>"), 0o644); err != nil {
		t.Fatal(err)
	}
	web := map[string]string{
		"https://example.com/a?b=1": "https://example.com/a?b=1",
		"HTTP://Example.com":        "HTTP://Example.com",
		"example.com/docs":          "https://example.com/docs",
		"localhost:3000":            "http://localhost:3000",
		"  127.0.0.1:8080/x ":       "http://127.0.0.1:8080/x",
	}
	for in, want := range web {
		got, file, err := moltenBrowserTarget(in)
		if err != nil || got != want || file != "" {
			t.Errorf("%q: page %q file %q err %v, want page %q", in, got, file, err, want)
		}
	}
	for _, in := range []string{page, "file://" + page, "file://localhost" + page} {
		got, file, err := moltenBrowserTarget(in)
		if err != nil || got != "" || !strings.HasPrefix(file, "file:///") || !strings.HasSuffix(file, "/my%20mockup.html") {
			t.Errorf("%q: page %q file %q err %v, want the file's address", in, got, file, err)
		}
	}
	for _, in := range []string{"", "   ", "ftp://example.com", "mailto://x", "about:blank", "data:text/html,<p>", "javascript:alert(1)",
		"file://other-host/etc/passwd", "file:", filepath.Join(dir, "missing.html"), dir, "/"} {
		if got, file, err := moltenBrowserTarget(in); err == nil {
			t.Errorf("%q must be refused, got page %q file %q", in, got, file)
		}
	}
}

func TestBrowserTargetTakesAnExistingFileThatLooksLikeAHost(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.html"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	_, file, err := moltenBrowserTarget("notes.html")
	if err != nil || !strings.HasSuffix(file, "/notes.html") || !strings.HasPrefix(file, "file:///") {
		t.Fatalf("a file of the folder opens as a file: %q %v", file, err)
	}
	if page, file, err := moltenBrowserTarget("docs.example"); err != nil || page != "https://docs.example" || file != "" {
		t.Fatalf("a name that is no file is an address: %q %q %v", page, file, err)
	}
}
