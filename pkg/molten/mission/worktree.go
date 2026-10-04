// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Closing a terminal linked to a worktree (FR-SHELL-016, DS-SHELL-016): the plan first (path, branch, uncommitted
// changes, commits no remote has, merged or not, the other terminals using it), then removal only when asked. As in
// branch cleaning (branches.go), every doubt keeps: a worktree with work in it is removed only after a second
// confirmation, git is forced only then, and the branch goes only when its content is on the trunk.

const (
	WorktreePlanCommand   = "moltenmissionworktreeplan"
	WorktreeRemoveCommand = "moltenmissionworktreeremove"

	worktreeTimeout    = 60 * time.Second
	worktreeMaxChanges = 20
)

type WorktreeRequest struct {
	Dir string `json:"dir"`
	// The terminal being closed: it is not counted among the others.
	BlockId string `json:"blockid,omitempty"`
}

type WorktreeTerminal struct {
	BlockId   string `json:"blockid"`
	Tab       string `json:"tab,omitempty"`
	Workspace string `json:"workspace,omitempty"`
	// Linked to the worktree; otherwise its folder is inside it.
	Linked bool `json:"linked,omitempty"`
}

type WorktreePlan struct {
	Path     string `json:"path"`
	Missing  bool   `json:"missing,omitempty"`
	Main     string `json:"main,omitempty"`
	Branch   string `json:"branch,omitempty"`
	Sha      string `json:"sha,omitempty"`
	Detached bool   `json:"detached,omitempty"`
	Locked   bool   `json:"locked,omitempty"`
	// Changes lists the first uncommitted paths; ChangeCount counts them all.
	Changes     []string `json:"changes"`
	ChangeCount int      `json:"changecount"`
	// Ignored files and folders, removed with the worktree.
	Ignored      []string `json:"ignored"`
	IgnoredCount int      `json:"ignoredcount"`
	// Unpushed counts the commits no remote has; without a remote, the commits no other branch has.
	Unpushed  int    `json:"unpushed"`
	NoRemote  bool   `json:"noremote,omitempty"`
	Trunk     string `json:"trunk,omitempty"`
	Merged    *bool  `json:"merged,omitempty"`
	Protected bool   `json:"protected,omitempty"`
	// The other open terminals linked to the worktree or working in it.
	Terminals []WorktreeTerminal `json:"terminals"`
}

type WorktreeRemoveRequest struct {
	Dir     string `json:"dir"`
	BlockId string `json:"blockid,omitempty"`
	// Confirmed: the user confirmed a second time that the uncommitted changes and unpushed commits may go.
	Confirmed    bool `json:"confirmed,omitempty"`
	DeleteBranch bool `json:"deletebranch,omitempty"`
}

type WorktreeRemoveResult struct {
	Removed       bool   `json:"removed"`
	Forced        bool   `json:"forced,omitempty"`
	BranchDeleted string `json:"branchdeleted,omitempty"`
	BranchKept    string `json:"branchkept,omitempty"`
}

type worktreeTerminalsFunc func(ctx context.Context, path string, exclude string) []WorktreeTerminal

type Worktrees struct {
	// One removal at a time: two terminals closing on the same worktree see it removed or not, never half.
	lock      sync.Mutex
	run       Runner
	terminals worktreeTerminalsFunc
}

func MakeWorktrees(run Runner, terminals worktreeTerminalsFunc) *Worktrees {
	if terminals == nil {
		terminals = openWorktreeTerminals
	}
	return &Worktrees{run: run, terminals: terminals}
}

func pathInside(path string, dir string) bool {
	return path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, string(filepath.Separator))+string(filepath.Separator))
}

// openWorktreeTerminals scans the open blocks: every block in the store is open in some tab.
func openWorktreeTerminals(ctx context.Context, path string, exclude string) []WorktreeTerminal {
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return nil
	}
	rtn := []WorktreeTerminal{}
	for _, block := range blocks {
		if block.OID == exclude || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
			continue
		}
		linked := filepath.Clean(block.Meta.GetString(molten.WorktreeMetaKey, "")) == path
		conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
		cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
		inside := (conn == "" || conn == "local") && filepath.IsAbs(cwd) && pathInside(filepath.Clean(cwd), path)
		if !linked && !inside {
			continue
		}
		term := WorktreeTerminal{BlockId: block.OID, Linked: linked}
		if tabId, err := wstore.DBFindTabForBlockId(ctx, block.OID); err == nil {
			if tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId); err == nil && tab != nil {
				term.Tab = tab.Name
			}
			if wsId, err := wstore.DBFindWorkspaceForTabId(ctx, tabId); err == nil {
				if ws, err := wstore.DBGet[*waveobj.Workspace](ctx, wsId); err == nil && ws != nil {
					term.Workspace = ws.Name
				}
			}
		}
		rtn = append(rtn, term)
	}
	return rtn
}

// changePath reads the path of a `git status --porcelain=v2` entry.
func changePath(line string) string {
	switch {
	case strings.HasPrefix(line, "? "), strings.HasPrefix(line, "! "):
		return line[2:]
	case strings.HasPrefix(line, "1 "):
		if parts := strings.SplitN(line, " ", 9); len(parts) == 9 {
			return parts[8]
		}
	case strings.HasPrefix(line, "2 "):
		if parts := strings.SplitN(line, " ", 10); len(parts) == 10 {
			return strings.SplitN(parts[9], "\t", 2)[0]
		}
	case strings.HasPrefix(line, "u "):
		if parts := strings.SplitN(line, " ", 11); len(parts) == 11 {
			return parts[10]
		}
	}
	return line
}

// listedWorktree finds path among the repository's worktrees; the first entry is the main tree, never a candidate.
// Paths are compared with symlinks resolved: git lists /private/tmp for /tmp on macOS.
func listedWorktree(out string, path string) (found bool, main bool, locked bool) {
	want, err := filepath.EvalSymlinks(path)
	if err != nil {
		want = path
	}
	first := true
	current := false
	for _, line := range strings.Split(out, "\n") {
		if entry, ok := strings.CutPrefix(line, "worktree "); ok {
			resolved, err := filepath.EvalSymlinks(entry)
			if err != nil {
				resolved = entry
			}
			current = filepath.Clean(resolved) == filepath.Clean(want)
			if current {
				found, main = true, first
			}
			first = false
			continue
		}
		if current && (line == "locked" || strings.HasPrefix(line, "locked ")) {
			locked = true
		}
	}
	return found, main, locked
}

func protectedBranches(dir string, trunk string) map[string]bool {
	configured := ConfiguredBranches(dir)
	protected := map[string]bool{trunk: true, "HEAD": true}
	if configured.Release != "" {
		protected[configured.Release] = true
	} else {
		protected["main"] = true
		protected["master"] = true
	}
	return protected
}

func (w *Worktrees) count(g *gitReader, args ...string) int {
	out, err := g.out(append([]string{"rev-list", "--count"}, args...)...)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(out))
	return n
}

func (w *Worktrees) plan(ctx context.Context, path string, blockId string) (WorktreePlan, error) {
	plan := WorktreePlan{Path: path, Changes: []string{}, Ignored: []string{}, Terminals: []WorktreeTerminal{}}
	if molten.WorktreeMissing(path) {
		plan.Missing = true
		return plan, nil
	}
	g := &gitReader{ctx: ctx, run: w.run, dir: path}
	out, err := g.out("rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir")
	if err != nil {
		return plan, err
	}
	_, common, linked := molten.ParseGitDirs(out)
	if !linked {
		return plan, fmt.Errorf("%s is not a linked worktree", path)
	}
	plan.Main = molten.MainCheckoutOf(common)
	list, err := g.out("worktree", "list", "--porcelain")
	if err != nil {
		return plan, err
	}
	found, isMain, locked := listedWorktree(list, path)
	if !found || isMain {
		return plan, fmt.Errorf("%s is not a linked worktree of its repository", path)
	}
	plan.Locked = locked
	// Ignored files go with the worktree without git asking (a .env, a build): the plan names them.
	status, err := g.out("status", "--porcelain=v2", "--branch", "--untracked-files=normal", "--ignored=traditional")
	if err != nil {
		return plan, err
	}
	st := parsePaneStatus(status)
	plan.Branch, plan.Sha, plan.Detached = st.branch, st.sha, st.detached
	for _, line := range strings.Split(status, "\n") {
		if line == "" || strings.HasPrefix(line, "# ") {
			continue
		}
		if strings.HasPrefix(line, "! ") {
			plan.IgnoredCount++
			if len(plan.Ignored) < worktreeMaxChanges {
				plan.Ignored = append(plan.Ignored, changePath(line))
			}
			continue
		}
		plan.ChangeCount++
		if len(plan.Changes) < worktreeMaxChanges {
			plan.Changes = append(plan.Changes, changePath(line))
		}
	}
	if plan.Sha != "" {
		remotes, _ := g.out("remote")
		plan.NoRemote = strings.TrimSpace(remotes) == ""
		switch {
		case plan.Detached:
			// A detached HEAD's own commits are lost with the worktree.
			plan.Unpushed = w.count(g, "HEAD", "--not", "--branches", "--remotes")
		case !plan.NoRemote:
			plan.Unpushed = w.count(g, "HEAD", "--not", "--remotes")
		default:
			plan.Unpushed = w.count(g, "HEAD", "--not", "--exclude=refs/heads/"+plan.Branch, "--branches")
		}
	}
	trunk, trunkRef := resolveTrunk(ctx, w.run, plan.Main)
	plan.Trunk = trunk
	if plan.Branch != "" {
		plan.Protected = protectedBranches(plan.Main, trunk)[plan.Branch]
		if trunkRef != "" && !plan.Protected {
			if trunkTree, err := g.out("rev-parse", trunkRef+"^{tree}"); err == nil {
				plan.Merged = contentOnTrunk(g, strings.TrimSpace(trunkTree), trunkRef, "refs/heads/"+plan.Branch)
			}
		}
	}
	plan.Terminals = w.terminals(ctx, path, blockId)
	return plan, nil
}

func checkWorktreeDir(dir string) (string, error) {
	if err := checkDir(dir); err != nil {
		return "", err
	}
	return filepath.Clean(dir), nil
}

// Plan says what closing would find in the worktree. Nothing is changed here.
func (w *Worktrees) Plan(req WorktreeRequest) (WorktreePlan, error) {
	path, err := checkWorktreeDir(req.Dir)
	if err != nil {
		return WorktreePlan{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	return w.plan(ctx, path, req.BlockId)
}

// Remove removes the worktree, its plan read again first: the plan the user saw is not trusted blindly.
func (w *Worktrees) Remove(req WorktreeRemoveRequest) (WorktreeRemoveResult, error) {
	path, err := checkWorktreeDir(req.Dir)
	if err != nil {
		return WorktreeRemoveResult{}, err
	}
	w.lock.Lock()
	defer w.lock.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), worktreeTimeout)
	defer cancel()
	plan, err := w.plan(ctx, path, req.BlockId)
	if err != nil {
		return WorktreeRemoveResult{}, err
	}
	if plan.Missing {
		return WorktreeRemoveResult{}, errors.New("the worktree is already gone")
	}
	if plan.Locked {
		return WorktreeRemoveResult{}, fmt.Errorf("the worktree is locked (git worktree unlock %s)", path)
	}
	atRisk := plan.ChangeCount > 0 || plan.Unpushed > 0
	if atRisk && !req.Confirmed {
		return WorktreeRemoveResult{}, errors.New("the worktree holds uncommitted changes or unpushed commits: removing it needs a second confirmation")
	}
	args := []string{"worktree", "remove"}
	// Only uncommitted changes make git refuse; commits stay on their branch.
	forced := plan.ChangeCount > 0
	if forced {
		args = append(args, "--force")
	}
	args = append(args, path)
	if _, err := w.run(ctx, plan.Main, "git", args...); err != nil {
		return WorktreeRemoveResult{}, err
	}
	result := WorktreeRemoveResult{Removed: true, Forced: forced}
	if !req.DeleteBranch {
		return result, nil
	}
	switch {
	case plan.Branch == "":
		result.BranchKept = "no branch (detached HEAD)"
	case plan.Protected:
		result.BranchKept = plan.Branch + " is a long-lived branch"
	case plan.Merged == nil:
		result.BranchKept = "could not tell whether " + plan.Branch + " is merged"
	case !*plan.Merged:
		result.BranchKept = plan.Branch + " is not merged into " + plan.Trunk
	case strings.HasPrefix(plan.Branch, "-") || !branchNameRegex.MatchString(plan.Branch):
		result.BranchKept = "unusual branch name"
	}
	if result.BranchKept != "" {
		return result, nil
	}
	// -D: a branch merged by rebase or squash is not an ancestor of the trunk; its content was checked instead.
	if _, err := w.run(ctx, plan.Main, "git", "branch", "-D", plan.Branch); err != nil {
		result.BranchKept = err.Error()
		return result, nil
	}
	result.BranchDeleted = plan.Branch
	return result, nil
}
