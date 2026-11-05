// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentlaunch

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// npm installs global packages per Node version: once a folder's .nvmrc (or the like) switches Node, an agent CLI
// installed under another version is no longer on PATH (#1922). The launcher then looks in the global bin folders of
// the other Node versions of the usual version managers.

const (
	NodeManagerNvm   = "nvm"
	NodeManagerFnm   = "fnm"
	NodeManagerVolta = "volta"
	NodeManagerAsdf  = "asdf"
	NodeManagerMise  = "mise"
)

// NodeManagers is the search order: managers in this order, each one's versions newest first.
var NodeManagers = []string{NodeManagerNvm, NodeManagerFnm, NodeManagerVolta, NodeManagerAsdf, NodeManagerMise}

// NodeVersionBin is the global bin folder of one Node version of a version manager. Version: as the folder names it,
// without a leading "v"; "" for Volta's shims folder, which serves every version.
type NodeVersionBin struct {
	Manager string
	Version string
	Dir     string
}

// AgentSearch is where the launcher found the agent. From: nil when it is on PATH, else the other Node version it
// comes from. PathNode: the version of the node on PATH, "" when it belongs to no version manager seen. Searched: the
// other Node versions' folders looked at, in order.
type AgentSearch struct {
	Path     string
	From     *NodeVersionBin
	PathNode string
	Searched []NodeVersionBin
}

// FindAgentBinary finds the agent's real program: on PATH first (FindRealBinary), then in the other Node versions'
// global bin folders (NodeVersionBins), with the same guards: never a launcher, never a relative folder.
func FindAgentBinary(name string, getenv func(string) string, isLauncher func(path string) bool) (AgentSearch, bool) {
	pathEnv := getenv("PATH")
	launcherDir := getenv(AgentBinDirVarName)
	if real, ok := FindRealBinary(name, pathEnv, launcherDir, isLauncher); ok {
		return AgentSearch{Path: real}, true
	}
	bins := NodeVersionBins(getenv)
	rtn := AgentSearch{Searched: bins, PathNode: pathNodeVersion(pathEnv, launcherDir, bins)}
	for i := range bins {
		real, ok := FindRealBinary(name, bins[i].Dir, launcherDir, isLauncher)
		if !ok {
			continue
		}
		rtn.Path, rtn.From = real, &bins[i]
		return rtn, true
	}
	return rtn, false
}

// pathNodeVersion is the version of the node on PATH, when its folder is one of the version managers'.
func pathNodeVersion(pathEnv string, launcherDir string, bins []NodeVersionBin) string {
	node, ok := FindRealBinary("node", pathEnv, launcherDir, nil)
	if !ok {
		return ""
	}
	dir := filepath.Clean(filepath.Dir(node))
	for _, bin := range bins {
		if bin.Version != "" && filepath.Clean(bin.Dir) == dir {
			return bin.Version
		}
	}
	return ""
}

// NodeVersionBins lists the global bin folders of the Node versions the version managers hold, in search order.
// Only absolute folders count; aliases (links between version folders) are skipped, their target is listed.
func NodeVersionBins(getenv func(string) string) []NodeVersionBin {
	home := getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	var rtn []NodeVersionBin
	seen := make(map[string]bool)
	add := func(bin NodeVersionBin) {
		if !filepath.IsAbs(bin.Dir) || seen[filepath.Clean(bin.Dir)] {
			return
		}
		if info, err := os.Stat(bin.Dir); err != nil || !info.IsDir() {
			return
		}
		seen[filepath.Clean(bin.Dir)] = true
		rtn = append(rtn, bin)
	}
	for _, manager := range NodeManagers {
		for _, root := range nodeManagerRoots(manager, getenv, home) {
			if manager == NodeManagerVolta {
				add(NodeVersionBin{Manager: manager, Dir: filepath.Join(root, "bin")})
			}
			parent, sub := nodeManagerLayout(manager)
			for _, version := range versionFolders(filepath.Join(root, parent)) {
				add(NodeVersionBin{Manager: manager, Version: strings.TrimPrefix(version, "v"), Dir: filepath.Join(root, parent, version, sub)})
			}
		}
	}
	return rtn
}

// nodeManagerRoots is where a manager keeps its data: its variable when set, else its default folders.
func nodeManagerRoots(manager string, getenv func(string) string, home string) []string {
	under := func(elems ...string) string {
		if home == "" {
			return ""
		}
		return filepath.Join(append([]string{home}, elems...)...)
	}
	dataHome := getenv("XDG_DATA_HOME")
	if dataHome == "" {
		dataHome = under(".local", "share")
	}
	switch manager {
	case NodeManagerNvm:
		if dir := getenv("NVM_DIR"); dir != "" {
			return []string{dir}
		}
		roots := []string{under(".nvm")}
		if config := getenv("XDG_CONFIG_HOME"); config != "" {
			roots = append(roots, filepath.Join(config, "nvm"))
		}
		return roots
	case NodeManagerFnm:
		if dir := getenv("FNM_DIR"); dir != "" {
			return []string{dir}
		}
		return []string{joinIfSet(dataHome, "fnm"), under("Library", "Application Support", "fnm"), under(".fnm")}
	case NodeManagerVolta:
		if dir := getenv("VOLTA_HOME"); dir != "" {
			return []string{dir}
		}
		return []string{under(".volta")}
	case NodeManagerAsdf:
		if dir := getenv("ASDF_DATA_DIR"); dir != "" {
			return []string{dir}
		}
		return []string{under(".asdf")}
	case NodeManagerMise:
		if dir := getenv("MISE_DATA_DIR"); dir != "" {
			return []string{dir}
		}
		return []string{joinIfSet(dataHome, "mise")}
	}
	return nil
}

func joinIfSet(dir string, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}

// nodeManagerLayout: the folder of a manager's version folders, and a version's bin folder inside it.
func nodeManagerLayout(manager string) (string, string) {
	switch manager {
	case NodeManagerNvm:
		return filepath.Join("versions", "node"), "bin"
	case NodeManagerFnm:
		return "node-versions", filepath.Join("installation", "bin")
	case NodeManagerVolta:
		return filepath.Join("tools", "image", "node"), "bin"
	case NodeManagerAsdf:
		return filepath.Join("installs", "nodejs"), "bin"
	case NodeManagerMise:
		return filepath.Join("installs", "node"), "bin"
	}
	return "", ""
}

// versionFolders lists the version folders of a folder, newest first; links (aliases such as mise's "22" or "lts")
// are left out.
func versionFolders(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var rtn []string
	for _, entry := range entries {
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			rtn = append(rtn, entry.Name())
		}
	}
	sort.SliceStable(rtn, func(i, j int) bool { return newerVersion(rtn[i], rtn[j]) })
	return rtn
}

// newerVersion orders version names: numerically by their dotted numbers, a name without numbers last, then by name
// so that the order never depends on the folder listing.
func newerVersion(a string, b string) bool {
	na, nb := versionNumbers(a), versionNumbers(b)
	if (na == nil) != (nb == nil) {
		return na != nil
	}
	for i := 0; i < len(na) && i < len(nb); i++ {
		if na[i] != nb[i] {
			return na[i] > nb[i]
		}
	}
	if len(na) != len(nb) {
		return len(na) > len(nb)
	}
	return a > b
}

func versionNumbers(name string) []int {
	name = strings.TrimPrefix(name, "v")
	if cut := strings.IndexAny(name, "-+"); cut >= 0 {
		name = name[:cut]
	}
	var rtn []int
	for _, part := range strings.Split(name, ".") {
		n, err := strconv.Atoi(part)
		if err != nil {
			return nil
		}
		rtn = append(rtn, n)
	}
	return rtn
}

// Label names the folder in a sentence: "Node v22.15.0 of nvm", or "Volta's shims".
func (bin NodeVersionBin) Label() string {
	if bin.Version == "" {
		return "Volta's shims"
	}
	return fmt.Sprintf("Node v%s of %s", bin.Version, bin.Manager)
}

// FallbackNote is the one line the launcher prints when it runs the agent from another Node version.
func FallbackNote(adapter LaunchAdapter, search AgentSearch) string {
	if search.From == nil {
		return ""
	}
	name := molten.AgentDisplayName(adapter.Id())
	if search.PathNode != "" {
		return fmt.Sprintf("%s: using %s from %s (not installed for v%s, the Node version on PATH)", adapter.Executable(), name, search.From.Label(), search.PathNode)
	}
	return fmt.Sprintf("%s: using %s from %s (not on PATH)", adapter.Executable(), name, search.From.Label())
}

// NotFoundMessage says what the launcher searched, and how to install the agent.
func NotFoundMessage(adapter LaunchAdapter, search AgentSearch) string {
	name := molten.AgentDisplayName(adapter.Id())
	var b strings.Builder
	fmt.Fprintf(&b, "%s: no %s found (MoltenTerm launcher).\n", adapter.Executable(), name)
	b.WriteString(searchedSentence(search.Searched))
	b.WriteString("\n")
	if search.PathNode != "" {
		fmt.Fprintf(&b, "To install it (for Node v%s): %s\n", search.PathNode, adapter.InstallCommand())
	} else {
		fmt.Fprintf(&b, "To install it: %s\n", adapter.InstallCommand())
	}
	return b.String()
}

func searchedSentence(bins []NodeVersionBin) string {
	if len(bins) == 0 {
		return fmt.Sprintf("Searched PATH; no other Node version found (%s).", strings.Join(NodeManagers, ", "))
	}
	var groups []string
	byManager := make(map[string][]string)
	for _, bin := range bins {
		if _, ok := byManager[bin.Manager]; !ok {
			groups = append(groups, bin.Manager)
		}
		label := "shims"
		if bin.Version != "" {
			label = "v" + bin.Version
		}
		byManager[bin.Manager] = append(byManager[bin.Manager], label)
	}
	parts := make([]string, 0, len(groups))
	for _, manager := range groups {
		parts = append(parts, fmt.Sprintf("%s (%s)", manager, strings.Join(byManager[manager], ", ")))
	}
	return fmt.Sprintf("Searched PATH and the global folders of these Node versions: %s.", strings.Join(parts, "; "))
}
