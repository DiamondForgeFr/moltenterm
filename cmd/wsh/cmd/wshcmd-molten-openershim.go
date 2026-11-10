// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
)

// The opener shims (FR-BRW-007, #2176). Many programs ignore BROWSER and call the OS opener themselves (the npm open
// package, a provider's sign-in): in a local MoltenTerm terminal `open` (macOS) and `xdg-open` (Linux) are wsh under
// that name, in the agent launchers' folder and in the openers folder (pkg/util/shellutil/moltenterm_molten.go). A
// call that only opens one http(s) page runs molten-open (`molten open --from-browser-env`), so the page goes to the
// browser panel of the pane's tab, or to the system when MoltenTerm cannot take it. Every other call (a file, a
// folder, -a <app>, another scheme, an option the shim does not know, several targets) runs the real opener with the
// same arguments: the shim never changes what is not a web page.

var moltenOpenerShimCmd = &cobra.Command{
	Use:                "openershim --tool <open|xdg-open> -- [args...]",
	Short:              "what open and xdg-open run in a MoltenTerm terminal (non-web calls)",
	Hidden:             true,
	DisableFlagParsing: true,
	RunE:               moltenOpenerShimRun,
}

// Where the real opener lives when PATH does not name it.
var moltenOpenerFallbackDirs = []string{"/usr/bin", "/usr/local/bin", "/bin"}

func init() {
	moltenCmd.AddCommand(moltenOpenerShimCmd)
}

func moltenIsOpenerShim(base string) bool {
	return slices.Contains(shellutil.OpenerShimNames(), base)
}

// moltenOpenerShimArgs is the wsh command line an opener shim runs, or nil when the program is no opener shim.
func moltenOpenerShimArgs(args []string, base string) []string {
	if !moltenIsOpenerShim(base) {
		return nil
	}
	if page, ok := moltenOpenerShimPage(base, args[1:]); ok {
		return []string{args[0], MoltenProgramName, "open", "--from-browser-env", "--", page}
	}
	rtn := []string{args[0], MoltenProgramName, "openershim", "--tool", base, "--"}
	return append(rtn, args[1:]...)
}

// moltenOpenerShimPage returns the page when the call only opens one web page: `xdg-open <url>`, or `open <url>` with
// at most -g/--background (the panel never takes the focus anyway) and the URL possibly given through -u.
func moltenOpenerShimPage(tool string, args []string) (string, bool) {
	if tool != "open" {
		if len(args) == 1 && moltenIsExplicitWebUrl(args[0]) {
			return args[0], true
		}
		return "", false
	}
	page := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-g" || arg == "--background":
			continue
		case arg == "-u" && i+1 < len(args):
			i++
			arg = args[i]
		case strings.HasPrefix(arg, "-"):
			return "", false
		}
		if page != "" || !moltenIsExplicitWebUrl(arg) {
			return "", false
		}
		page = arg
	}
	return page, page != ""
}

// moltenIsExplicitWebUrl accepts only http:// or https:// with a host: a bare word may be a file the real opener
// must get.
func moltenIsExplicitWebUrl(text string) bool {
	lower := strings.ToLower(text)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return false
	}
	u, err := url.Parse(text)
	return err == nil && u.Host != "" && u.Hostname() != ""
}

func moltenOpenerShimRun(cmd *cobra.Command, args []string) error {
	if len(args) < 3 || args[0] != "--tool" || args[2] != "--" || !moltenIsOpenerShim(args[1]) {
		WriteStderr("usage: molten openershim --tool <open|xdg-open> -- [args...]\n")
		WshExitCode = 2
		return nil
	}
	real, found := moltenRealOpener(args[1])
	if !found {
		WriteStderr("%s: command not found (MoltenTerm opener shim)\n", args[1])
		WshExitCode = moltenAgentLaunchMissingCode
		return nil
	}
	WshExitCode = execAgentBinary(real, args[3:], os.Environ())
	return nil
}

// moltenRealOpener finds the system's opener by absolute path, never a MoltenTerm shim (this one or another build's):
// the shim and molten-open's fallback must never call themselves.
func moltenRealOpener(tool string) (string, bool) {
	if real, found := agentlaunch.FindRealBinary(tool, os.Getenv("PATH"), os.Getenv(agentlaunch.AgentBinDirVarName), agentlaunch.IsLauncher); found {
		return real, true
	}
	return agentlaunch.FindRealBinary(tool, strings.Join(moltenOpenerFallbackDirs, string(filepath.ListSeparator)), "", agentlaunch.IsLauncher)
}
