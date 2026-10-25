// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
)

// The merge queue's worktrees go when nothing would be lost (#1122, FR-REV-025). A commit is safe when a remote has
// it, when a head the queue pushed or merged reaches it (GitHub keeps those under refs/pull/<n>/head after the
// branch is deleted, so a squash or rebase merge does not make them "unpushed"), or when its content is already on
// the base. Uncommitted files and a rebase or merge stopped halfway always keep the worktree. The earlier queues'
// worktrees (batch-merge, batch-merge-N) go under the same rule before a new one is made and when a run ends, unless a
// live run uses them, or they are locked, or a terminal or a process is in them.

var batchTreeNameRegex = regexp.MustCompile(`^` + batchTreeName + `(-[0-9]+)?$`)

// BatchTree is an earlier queue's worktree that stays, and why (BatchKept…).
type BatchTree struct {
	Path string `json:"path"`
	Kept string `json:"kept"`
}

type batchTreeEntry struct {
	path     string
	detached bool
	locked   bool
	prunable bool
}

func gitRunnerOf(git reviewsession.GitRunner) mission.Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		return git(ctx, dir, args...)
	}
}

// commitsLost counts the tree's commits that removing it would lose; lossUnknown when git could not tell.
func (b *BatchRunner) commitsLost(ctx context.Context, tree string, heads []string, bases []string) int {
	r := b.env.Agents
	args := []string{"rev-list", "--count", "HEAD", "--not", "--remotes"}
	for _, head := range heads {
		if _, err := r.git(ctx, tree, "cat-file", "-e", head+"^{commit}"); err == nil {
			args = append(args, head)
		}
	}
	out, err := r.git(ctx, tree, args...)
	if err != nil {
		return lossUnknown
	}
	n, err := strconv.Atoi(out)
	if err != nil {
		return lossUnknown
	}
	if n == 0 {
		return 0
	}
	for _, base := range bases {
		on := mission.BranchContentOn(ctx, gitRunnerOf(r.env.Git), tree, "refs/remotes/origin/"+base, "HEAD")
		if on != nil && *on {
			return 0
		}
	}
	return n
}

// treeWorkKept: why removing the tree would lose work, "" when it would not.
func (b *BatchRunner) treeWorkKept(ctx context.Context, tree string, heads []string, bases []string) string {
	r := b.env.Agents
	status, err := r.git(ctx, tree, "status", "--porcelain", "--untracked-files=normal")
	if err != nil {
		return BatchKeptUnread
	}
	for _, name := range []string{"rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"} {
		path, err := r.git(ctx, tree, "rev-parse", "--git-path", name)
		if err != nil || path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(tree, path)
		}
		if pathExists(path) {
			return BatchKeptRebasing
		}
	}
	if strings.TrimSpace(status) != "" {
		return BatchKeptChanges
	}
	switch n := b.commitsLost(ctx, tree, heads, bases); {
	case n == lossUnknown:
		return BatchKeptUnread
	case n > 0:
		return BatchKeptUnpushed
	}
	return ""
}

// runHeads: the heads a run knows were on GitHub, the ones it pushed or merged among them.
func runHeads(run BatchRun) []string {
	var rtn []string
	for _, it := range run.Items {
		for _, oid := range []string{it.Head, it.Valid, it.HeadOid} {
			if isOid(oid) {
				rtn = append(rtn, oid)
			}
		}
	}
	return rtn
}

// projectHeads gathers the heads and bases of every queue of the project MoltenTerm kept, the current one included.
func (b *BatchRunner) projectHeads(dir string, current BatchRun) ([]string, []string) {
	heads := runHeads(current)
	bases := []string{current.Base}
	entries, _ := os.ReadDir(filepath.Join(b.env.DataDir, "molten", "reviews", batchDirName))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		run, ok := readRun(filepath.Join(b.env.DataDir, "molten", "reviews", batchDirName, entry.Name()))
		if !ok || filepath.Clean(run.Dir) != filepath.Clean(dir) || run.Id == current.Id {
			continue
		}
		heads = append(heads, runHeads(run)...)
		if run.Base != "" && !slices.Contains(bases, run.Base) {
			bases = append(bases, run.Base)
		}
	}
	return dedupe(heads), bases
}

func dedupe(list []string) []string {
	seen := map[string]bool{}
	var rtn []string
	for _, s := range list {
		if !seen[s] {
			seen[s] = true
			rtn = append(rtn, s)
		}
	}
	return rtn
}

// liveTrees: the worktrees the queues running now use.
func (b *BatchRunner) liveTrees() []string {
	b.lock.Lock()
	defer b.lock.Unlock()
	var rtn []string
	for _, ctl := range b.runs {
		if ctl.run.Worktree != "" && ctl.run.active() {
			rtn = append(rtn, ctl.run.Worktree)
		}
		if ctl.agent != nil && ctl.agent.tree != "" && ctl.run.active() {
			rtn = append(rtn, ctl.agent.tree)
		}
	}
	return rtn
}

// batchTrees lists the project's merge queue worktrees: detached, named batch-merge or batch-merge-N, in its folder
// of MoltenTerm's review worktrees.
func (b *BatchRunner) batchTrees(ctx context.Context, dir string) ([]batchTreeEntry, error) {
	out, err := b.env.Agents.git(ctx, dir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, err
	}
	parent := resolvedPath(reviewsession.ReviewTreesDir(b.env.DataDir, dir))
	var all []batchTreeEntry
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			all = append(all, batchTreeEntry{path: path})
			continue
		}
		if len(all) == 0 {
			continue
		}
		e := &all[len(all)-1]
		switch {
		case line == "detached":
			e.detached = true
		case line == "locked" || strings.HasPrefix(line, "locked "):
			e.locked = true
		case line == "prunable" || strings.HasPrefix(line, "prunable "):
			e.prunable = true
		}
	}
	var rtn []batchTreeEntry
	for i, e := range all {
		if i == 0 || !batchTreeNameRegex.MatchString(filepath.Base(e.path)) {
			continue
		}
		if resolvedPath(filepath.Dir(e.path)) != parent {
			continue
		}
		rtn = append(rtn, e)
	}
	return rtn, nil
}

// treeInUse: a terminal of MoltenTerm or a live process works in the tree.
func (b *BatchRunner) treeInUse(ctx context.Context, path string) bool {
	if env := b.env.Agents.env; env.Terminals != nil && len(env.Terminals(ctx, path)) > 0 {
		return true
	}
	return b.env.TreeInUse != nil && b.env.TreeInUse(path)
}

// sweepTrees removes the project's earlier merge queue worktrees that hold nothing to lose and that nothing uses;
// keep is the current run's tree, left alone. It returns those that stay.
func (b *BatchRunner) sweepTrees(ctx context.Context, current BatchRun, keep string) []BatchTree {
	if b.env.Agents == nil {
		return nil
	}
	dir := current.Dir
	entries, err := b.batchTrees(ctx, dir)
	if err != nil {
		log.Printf("%s queue: the earlier worktrees could not be listed: %v\n", logPrefix, err)
		return nil
	}
	live := b.liveTrees()
	if keep != "" {
		live = append(live, keep)
	}
	var heads, bases []string
	var rtn []BatchTree
	pruned := false
	for _, e := range entries {
		if !e.detached || slices.ContainsFunc(live, func(p string) bool { return samePath(p, e.path) }) {
			continue
		}
		if e.prunable || !pathExists(e.path) {
			pruned = true
			continue
		}
		kept := ""
		switch {
		case e.locked:
			kept = BatchKeptLocked
		case b.treeInUse(ctx, e.path):
			kept = BatchKeptInUse
		default:
			if heads == nil {
				heads, bases = b.projectHeads(dir, current)
			}
			kept = b.treeWorkKept(ctx, e.path, heads, bases)
		}
		if kept != "" {
			rtn = append(rtn, BatchTree{Path: e.path, Kept: kept})
			continue
		}
		if !b.removeTree(ctx, dir, e.path) {
			rtn = append(rtn, BatchTree{Path: e.path, Kept: BatchKeptUnread})
			continue
		}
		log.Printf("%s queue: the earlier worktree %s went\n", logPrefix, e.path)
	}
	if pruned {
		b.env.Agents.git(ctx, dir, "worktree", "prune")
	}
	return rtn
}

// removeTree removes a merge queue worktree whose work was read safe; the folder goes only inside the project's
// review worktrees folder.
func (b *BatchRunner) removeTree(ctx context.Context, dir string, tree string) bool {
	r := b.env.Agents
	if _, err := r.git(ctx, dir, "worktree", "remove", "--force", tree); err != nil {
		log.Printf("%s queue: the worktree %s could not be removed: %v\n", logPrefix, tree, err)
	}
	if pathExists(tree) && pathInside(tree, reviewsession.ReviewTreesDir(b.env.DataDir, dir)) {
		os.RemoveAll(tree)
	}
	r.git(ctx, dir, "worktree", "prune")
	return !pathExists(tree)
}

// SweepTrees cleans the earlier merge queue worktrees of the projects MoltenTerm kept a queue of, once at start-up
// after the running queues resumed.
func (b *BatchRunner) SweepTrees() {
	dir := filepath.Join(b.env.DataDir, "molten", "reviews", batchDirName)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		run, ok := readRun(filepath.Join(dir, entry.Name()))
		if !ok || run.active() || seen[filepath.Clean(run.Dir)] || !pathExists(run.Dir) {
			continue
		}
		seen[filepath.Clean(run.Dir)] = true
		ctx, cancel := context.WithTimeout(context.Background(), batchStepTimeout)
		kept := b.sweepTrees(ctx, run, "")
		cancel()
		for _, t := range kept {
			log.Printf("%s queue: the earlier worktree %s is kept: %s\n", logPrefix, t.Path, t.Kept)
		}
	}
}
