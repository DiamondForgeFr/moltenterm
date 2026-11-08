// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentlaunch

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// nodeHome is a home with no version manager yet, and a PATH that holds no agent.
func nodeHome(t *testing.T) (string, map[string]string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	empty := filepath.Join(root, "usr", "bin")
	os.MkdirAll(home, 0755)
	os.MkdirAll(empty, 0755)
	return home, map[string]string{"HOME": home, "PATH": empty}
}

func getenvOf(env map[string]string) func(string) string {
	return func(name string) string { return env[name] }
}

// #1922: .nvmrc switched to v24.19.0, Codex is installed under v22.15.0 only: the launcher runs v22.15.0's, and its
// note names both versions.
func TestFindAgentBinaryInAnotherNodeVersion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix layouts")
	}
	home, env := nodeHome(t)
	nodes := filepath.Join(home, ".nvm", "versions", "node")
	writeExec(t, filepath.Join(nodes, "v24.19.0", "bin", "node"))
	writeExec(t, filepath.Join(nodes, "v22.15.0", "bin", "node"))
	writeExec(t, filepath.Join(nodes, "v22.15.0", "bin", "codex"))
	writeExec(t, filepath.Join(nodes, "v20.11.1", "bin", "codex"))
	env["PATH"] = filepath.Join(nodes, "v24.19.0", "bin") + string(os.PathListSeparator) + env["PATH"]

	search, ok := FindAgentBinary("codex", getenvOf(env), IsLauncher)
	if !ok || search.Path != filepath.Join(nodes, "v22.15.0", "bin", "codex") {
		t.Fatalf("got %+v %v, want v22.15.0's codex (newest that has it)", search, ok)
	}
	if search.From == nil || search.From.Manager != NodeManagerNvm || search.From.Version != "22.15.0" || search.PathNode != "24.19.0" {
		t.Fatalf("from %+v, path node %q", search.From, search.PathNode)
	}
	want := "codex: using Codex from Node v22.15.0 of nvm (not installed for v24.19.0, the Node version on PATH)"
	if got := FallbackNote(codexAdapter{}, search); got != want {
		t.Fatalf("note %q, want %q", got, want)
	}

	writeExec(t, filepath.Join(nodes, "v24.19.0", "bin", "codex"))
	search, ok = FindAgentBinary("codex", getenvOf(env), IsLauncher)
	if !ok || search.From != nil || FallbackNote(codexAdapter{}, search) != "" {
		t.Fatalf("on PATH: %+v %v, want PATH's codex and no note", search, ok)
	}
}

// Nothing anywhere: the message says what was searched and gives the adapter's install command.
func TestFindAgentBinaryNothingFound(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix layouts")
	}
	home, env := nodeHome(t)
	search, ok := FindAgentBinary("codex", getenvOf(env), IsLauncher)
	if ok || len(search.Searched) != 0 {
		t.Fatalf("empty home: %+v %v", search, ok)
	}
	msg := NotFoundMessage(codexAdapter{}, search)
	for _, want := range []string{"codex: no Codex found (MoltenTerm launcher).", "no other Node version found (nvm, fnm, volta, asdf, mise)", "To install it: npm install -g @openai/codex"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q lacks %q", msg, want)
		}
	}

	nodes := filepath.Join(home, ".nvm", "versions", "node")
	writeExec(t, filepath.Join(nodes, "v24.19.0", "bin", "node"))
	writeExec(t, filepath.Join(nodes, "v22.15.0", "bin", "node"))
	writeExec(t, filepath.Join(home, ".asdf", "installs", "nodejs", "18.20.4", "bin", "node"))
	env["PATH"] = filepath.Join(nodes, "v24.19.0", "bin")
	search, ok = FindAgentBinary("claude", getenvOf(env), IsLauncher)
	if ok {
		t.Fatalf("found %q", search.Path)
	}
	msg = NotFoundMessage(claudeAdapter{}, search)
	for _, want := range []string{
		"claude: no Claude Code found (MoltenTerm launcher).",
		"Searched PATH and the global folders of these Node versions: nvm (v24.19.0, v22.15.0); asdf (v18.20.4).",
		"To install it (for Node v24.19.0): curl -fsSL https://claude.ai/install.sh | bash",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q lacks %q", msg, want)
		}
	}
}

// A launcher in another version's folder (a link to wsh) is never run, and neither is a file that is not executable:
// the search goes on to the next version.
func TestFindAgentBinarySkipsLaunchers(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	home, env := nodeHome(t)
	data := filepath.Join(filepath.Dir(home), "data", "bin")
	writeExec(t, filepath.Join(data, "wsh"))
	nodes := filepath.Join(home, ".nvm", "versions", "node")
	os.MkdirAll(filepath.Join(nodes, "v24.0.0", "bin"), 0755)
	os.Symlink(filepath.Join(data, "wsh"), filepath.Join(nodes, "v24.0.0", "bin", "codex"))
	os.MkdirAll(filepath.Join(nodes, "v23.0.0", "bin"), 0755)
	os.WriteFile(filepath.Join(nodes, "v23.0.0", "bin", "codex"), nil, 0644)
	writeExec(t, filepath.Join(nodes, "v22.0.0", "bin", "codex"))

	search, ok := FindAgentBinary("codex", getenvOf(env), IsLauncher)
	if !ok || search.Path != filepath.Join(nodes, "v22.0.0", "bin", "codex") {
		t.Fatalf("got %+v %v, want v22.0.0's codex", search, ok)
	}
	os.Remove(filepath.Join(nodes, "v22.0.0", "bin", "codex"))
	if search, ok := FindAgentBinary("codex", getenvOf(env), IsLauncher); ok {
		t.Fatalf("only a launcher and a plain file left: found %q", search.Path)
	}

	t.Chdir(filepath.Dir(home))
	env["NVM_DIR"] = "relative-nvm"
	os.MkdirAll(filepath.Join("relative-nvm", "versions", "node", "v1.0.0", "bin"), 0755)
	if bins := NodeVersionBins(getenvOf(env)); slices.ContainsFunc(bins, func(b NodeVersionBin) bool { return b.Manager == NodeManagerNvm }) {
		t.Fatalf("a relative NVM_DIR must be skipped: %+v", bins)
	}
}

// The order: managers in NodeManagers' order, each one's versions newest first (numerically, not as text), aliases
// left out; each manager's variable replaces its default folder.
func TestNodeVersionBinsOrder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	home, env := nodeHome(t)
	root := filepath.Dir(home)
	nvm := filepath.Join(root, "custom-nvm", "versions", "node")
	for _, v := range []string{"v9.11.2", "v22.15.0", "v22.4.1", "v24.19.0"} {
		os.MkdirAll(filepath.Join(nvm, v, "bin"), 0755)
	}
	os.MkdirAll(filepath.Join(home, ".nvm", "versions", "node", "v99.0.0", "bin"), 0755)
	env["NVM_DIR"] = filepath.Join(root, "custom-nvm")
	os.MkdirAll(filepath.Join(home, ".local", "share", "fnm", "node-versions", "v20.0.0", "installation", "bin"), 0755)
	os.MkdirAll(filepath.Join(home, ".volta", "bin"), 0755)
	os.MkdirAll(filepath.Join(home, ".volta", "tools", "image", "node", "18.0.0", "bin"), 0755)
	os.MkdirAll(filepath.Join(home, ".asdf", "installs", "nodejs", "16.0.0", "bin"), 0755)
	mise := filepath.Join(home, ".local", "share", "mise", "installs", "node")
	os.MkdirAll(filepath.Join(mise, "21.7.3", "bin"), 0755)
	os.Symlink(filepath.Join(mise, "21.7.3"), filepath.Join(mise, "21"))
	os.Symlink(filepath.Join(mise, "21.7.3"), filepath.Join(mise, "lts"))

	var got []string
	for _, bin := range NodeVersionBins(getenvOf(env)) {
		got = append(got, bin.Manager+" "+bin.Version)
	}
	want := []string{"nvm 24.19.0", "nvm 22.15.0", "nvm 22.4.1", "nvm 9.11.2", "fnm 20.0.0", "volta ", "volta 18.0.0", "asdf 16.0.0", "mise 21.7.3"}
	if !slices.Equal(got, want) {
		t.Fatalf("order %q, want %q", got, want)
	}
}

func TestAdaptersHaveInstallCommands(t *testing.T) {
	for _, name := range LauncherNames() {
		if AdapterForProgram(name).InstallCommand() == "" {
			t.Fatalf("%s has no install command", name)
		}
	}
}
