// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Closing a terminal linked to a worktree (FR-SHELL-016, DS-SHELL-016): the plan first (path, branch, uncommitted
// changes, commits no remote has, merged or not, ignored files, the other terminals using it), then removal only when
// asked. As in branch cleaning (branches.go), every doubt keeps: a worktree with work in it, ignored files or other
// terminals is removed only after a second confirmation given for the plan the user saw, git is forced only then, and
// the branch goes only when its content is on the trunk.

const (
	WorktreePlanCommand   = "moltenmissionworktreeplan"
	WorktreeRemoveCommand = "moltenmissionworktreeremove"

	worktreeTimeout    = 60 * time.Second
	worktreeMaxChanges = 20
	// UnknownCount: git could not count; read as "there may be work".
	UnknownCount = -1
)

type WorktreeRequest struct {
	Dir string `json:"dir"`
	// The terminal being closed: it is not counted among the others.
	BlockId string `json:"blockid,omitempty"`
	// Every terminal closed with it (a whole tab): none of them is counted among the others.
	BlockIds []string `json:"blockids,omitempty"`
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
	// Ignored files and folders, removed with the worktree. Ignored files (a .env) count as work at risk; ignored
	// folders (node_modules/, a build) are named only.
	Ignored          []string `json:"ignored"`
	IgnoredCount     int      `json:"ignoredcount"`
	IgnoredFileCount int      `json:"ignoredfilecount"`
	// Unpushed counts the commits no remote has; without a remote, the commits no other branch has. UnknownCount when
	// git could not tell.
	Unpushed  int    `json:"unpushed"`
	NoRemote  bool   `json:"noremote,omitempty"`
	Trunk     string `json:"trunk,omitempty"`
	Merged    *bool  `json:"merged,omitempty"`
	Protected bool   `json:"protected,omitempty"`
	// The other open terminals linked to the worktree or working in it.
	Terminals []WorktreeTerminal `json:"terminals"`
	// Refused: MoltenTerm will not remove this folder whatever the answer (the home folder, a folder holding its
	// repository).
	Refused string `json:"refused,omitempty"`
}

// WorktreeRisk is what the user confirmed a second time; the removal is refused when the worktree holds more.
type WorktreeRisk struct {
	Sha              string `json:"sha"`
	ChangeCount      int    `json:"changecount"`
	Unpushed         int    `json:"unpushed"`
	IgnoredFileCount int    `json:"ignoredfilecount"`
}

type WorktreeRemoveRequest struct {
	Dir      string   `json:"dir"`
	BlockId  string   `json:"blockid,omitempty"`
	BlockIds []string `json:"blockids,omitempty"`
	// Confirmed: the plan the user confirmed a second time. Without it, only a worktree with nothing at risk goes.
	Confirmed    *WorktreeRisk `json:"confirmed,omitempty"`
	DeleteBranch bool          `json:"deletebranch,omitempty"`
}

type WorktreeRemoveResult struct {
	Removed bool `json:"removed"`
	// Gone: someone removed it first (another terminal's close, git outside MoltenTerm).
	Gone          bool   `json:"gone,omitempty"`
	Forced        bool   `json:"forced,omitempty"`
	BranchDeleted string `json:"branchdeleted,omitempty"`
	BranchKept    string `json:"branchkept,omitempty"`
}

type worktreeTerminalsFunc func(ctx context.Context, path string, exclude []string) []WorktreeTerminal

type Worktrees struct {
	// One removal at a time: two terminals closing on the same worktree see it removed or not, never half.
	lock      sync.Mutex
	run       Runner
	terminals worktreeTerminalsFunc
	home      string
}

func MakeWorktrees(run Runner, terminals worktreeTerminalsFunc) *Worktrees {
	if terminals == nil {
		terminals = openWorktreeTerminals
	}
	home, _ := os.UserHomeDir()
	return &Worktrees{run: hardenedGit(run), terminals: terminals, home: home}
}

// hardenedGit keeps git from running a program the repository's config names: the folder comes from a block's meta,
// which any terminal can set.
func hardenedGit(run Runner) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		if name == "git" {
			args = append([]string{"-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"}, args...)
		}
		return run(ctx, dir, name, args...)
	}
}

func pathInside(path string, dir string) bool {
	return path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, string(filepath.Separator))+string(filepath.Separator))
}

// realPath resolves symlinks (/tmp is /private/tmp on macOS); for a path that no longer exists, its deepest existing
// parent is resolved and the rest kept.
func realPath(path string) string {
	if path == "" {
		return ""
	}
	path = filepath.Clean(path)
	rest := ""
	for dir := path; ; dir = filepath.Dir(dir) {
		if resolved, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(resolved, rest)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return path
		}
		rest = filepath.Join(filepath.Base(dir), rest)
	}
}

// openWorktreeTerminals scans the blocks of every workspace: a terminal of a workspace no window shows still works in
// the worktree when that workspace comes back.
func openWorktreeTerminals(ctx context.Context, path string, exclude []string) []WorktreeTerminal {
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return nil
	}
	real := realPath(path)
	rtn := []WorktreeTerminal{}
	for _, block := range blocks {
		if slices.Contains(exclude, block.OID) || block.Meta.GetString(waveobj.MetaKey_View, "") != "term" {
			continue
		}
		link := block.Meta.GetString(molten.WorktreeMetaKey, "")
		linked := link != "" && realPath(link) == real
		conn := block.Meta.GetString(waveobj.MetaKey_Connection, "")
		cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
		inside := (conn == "" || conn == "local") && filepath.IsAbs(cwd) && pathInside(realPath(cwd), real)
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
	want := realPath(path)
	first := true
	current := false
	for _, line := range strings.Split(out, "\n") {
		if entry, ok := strings.CutPrefix(line, "worktree "); ok {
			current = realPath(entry) == want
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

// worktreeBacklinked checks git's own records both ways: the worktree's .git file names an admin folder under the
// repository's worktrees/, and that folder's gitdir names the worktree back.
func worktreeBacklinked(path string, gitDir string, common string) bool {
	if !pathInside(realPath(gitDir), filepath.Join(realPath(common), "worktrees")) {
		return false
	}
	data, err := os.ReadFile(filepath.Join(gitDir, "gitdir"))
	if err != nil {
		return false
	}
	back := strings.TrimSpace(string(data))
	if !filepath.IsAbs(back) {
		back = filepath.Join(gitDir, back)
	}
	return realPath(back) == filepath.Join(realPath(path), ".git")
}

// refusal names a folder MoltenTerm never removes, whatever git says: the home folder or one of its parents, a folder
// holding its own repository.
func (w *Worktrees) refusal(path string, main string) string {
	real := realPath(path)
	if w.home != "" && pathInside(realPath(w.home), real) {
		return "the home folder"
	}
	if real == "/" || pathInside(realPath(main), real) {
		return "it holds its repository"
	}
	return ""
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
		return UnknownCount
	}
	n, err := strconv.Atoi(strings.TrimSpace(out))
	if err != nil {
		return UnknownCount
	}
	return n
}

func (w *Worktrees) unpushed(g *gitReader, plan *WorktreePlan) {
	remotes, err := g.out("remote")
	if err != nil {
		plan.Unpushed = UnknownCount
		return
	}
	plan.NoRemote = strings.TrimSpace(remotes) == ""
	switch {
	case plan.Detached:
		// A detached HEAD's own commits are lost with the worktree.
		plan.Unpushed = w.count(g, "HEAD", "--not", "--branches", "--remotes")
	case !plan.NoRemote:
		plan.Unpushed = w.count(g, "HEAD", "--not", "--remotes")
	case strings.HasPrefix(plan.Branch, "-") || !branchNameRegex.MatchString(plan.Branch):
		// --exclude takes a pattern: a name it could misread is not counted.
		plan.Unpushed = UnknownCount
	default:
		plan.Unpushed = w.count(g, "HEAD", "--not", "--exclude=refs/heads/"+plan.Branch, "--branches")
	}
}

// closingBlocks: the terminal being closed and those closed with it.
func closingBlocks(blockId string, blockIds []string) []string {
	rtn := []string{}
	for _, id := range append([]string{blockId}, blockIds...) {
		if id != "" {
			rtn = append(rtn, id)
		}
	}
	return rtn
}

func (w *Worktrees) plan(ctx context.Context, path string, closing []string) (WorktreePlan, error) {
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
	gitDir, common, linked := molten.ParseGitDirs(out)
	if !linked || !worktreeBacklinked(path, gitDir, common) {
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
	plan.Refused = w.refusal(path, plan.Main)
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
			entry := changePath(line)
			plan.IgnoredCount++
			if !strings.HasSuffix(entry, "/") {
				plan.IgnoredFileCount++
			}
			if len(plan.Ignored) < worktreeMaxChanges {
				plan.Ignored = append(plan.Ignored, entry)
			}
			continue
		}
		plan.ChangeCount++
		if len(plan.Changes) < worktreeMaxChanges {
			plan.Changes = append(plan.Changes, changePath(line))
		}
	}
	if plan.Sha != "" {
		w.unpushed(g, &plan)
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
	plan.Terminals = w.terminals(ctx, path, closing)
	return plan, nil
}

// UnpushedAtRisk: commits no remote has, unless the branch's content is on the trunk (#97's check): a branch merged
// by squash or rebase whose remote branch was deleted loses only its history. Commits git could not count still ask.
func (p WorktreePlan) UnpushedAtRisk() bool {
	if p.Unpushed > 0 && p.Merged != nil && *p.Merged {
		return false
	}
	return p.Unpushed != 0
}

// NeedsConfirmation: removing loses something (work, ignored files, commits git could not count) or pulls the folder
// from under another terminal.
func (p WorktreePlan) NeedsConfirmation() bool {
	return p.ChangeCount > 0 || p.UnpushedAtRisk() || p.IgnoredFileCount > 0 || len(p.Terminals) > 0
}

// grewSince tells whether the worktree holds more than the user confirmed losing.
func (p WorktreePlan) grewSince(risk WorktreeRisk) bool {
	if p.Sha != risk.Sha || p.ChangeCount > risk.ChangeCount || p.IgnoredFileCount > risk.IgnoredFileCount {
		return true
	}
	if p.Unpushed == UnknownCount {
		return risk.Unpushed != UnknownCount
	}
	return risk.Unpushed != UnknownCount && p.Unpushed > risk.Unpushed
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
	return w.plan(ctx, path, closingBlocks(req.BlockId, req.BlockIds))
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
	plan, err := w.plan(ctx, path, closingBlocks(req.BlockId, req.BlockIds))
	if err != nil {
		return WorktreeRemoveResult{}, err
	}
	if plan.Missing {
		return WorktreeRemoveResult{Gone: true}, nil
	}
	if plan.Locked {
		return WorktreeRemoveResult{}, fmt.Errorf("the worktree is locked (git worktree unlock %s)", path)
	}
	if plan.Refused != "" {
		return WorktreeRemoveResult{}, fmt.Errorf("MoltenTerm does not remove %s: %s", path, plan.Refused)
	}
	if plan.NeedsConfirmation() {
		if req.Confirmed == nil {
			return WorktreeRemoveResult{}, errors.New("the worktree holds work or is used by another terminal: removing it needs a second confirmation")
		}
		if plan.grewSince(*req.Confirmed) {
			return WorktreeRemoveResult{}, errors.New("the worktree changed since you confirmed: read the plan again")
		}
	}
	args := []string{"worktree", "remove"}
	// Only uncommitted changes make git refuse; commits stay on their branch.
	forced := plan.ChangeCount > 0
	if forced {
		args = append(args, "--force")
	}
	args = append(args, "--", path)
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
