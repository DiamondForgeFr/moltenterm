// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewsession"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The local working branch after a merge (#909): the merge happens on GitHub, so the developer's local trunk (develop)
// stays where it was and every branch started from it starts from stale code. Once the cleanup fetched, the trunk is
// fast-forwarded to origin's when that is safe, and left alone otherwise: never a merge commit, a rebase, a stash or
// another branch. Not checked out anywhere, its ref moves (guarded by its old value); checked out in a worktree, `git
// merge --ff-only` runs there, which git refuses when a local change would be overwritten. A refusal changes nothing
// and says why by notification; an update shows as a line of the Validate sheet and of the batch's last notification.

const (
	CleanupStepLocalTrunk = "local-trunk"

	CleanupCodeTrunkUpdated  = "updated"
	CleanupCodeTrunkUpToDate = "uptodate"
	CleanupCodeNoLocalTrunk  = "nolocaltrunk"
	CleanupCodeNoRemoteTrunk = "noremotetrunk"
	// Refusals: commits on the local trunk that origin lacks, a local change the update would overwrite, an operation
	// (rebase, merge, cherry-pick, revert, bisect) in progress on it.
	CleanupCodeTrunkLocalCommits = "localcommits"
	CleanupCodeTrunkChanges      = "changes"
	CleanupCodeTrunkInProgress   = "inprogress"

	trunkNoticePrefix = "review:trunk:"
	// TerminalGesture opens a terminal in args.path; registered by the notification center.
	TerminalGesture = "path:terminal"
	trunkNamesShown = 3
)

// TrunkRefusals are the codes of a sync that was refused, not failed: nothing was changed and the notification says why.
var TrunkRefusals = []string{CleanupCodeTrunkLocalCommits, CleanupCodeTrunkChanges, CleanupCodeTrunkInProgress}

// trunkOf is the branch the local sync works on: the project's working branch, else the base the PR merged into.
func trunkOf(dir string, base string) string {
	if trunk := molten.ConfiguredBranches(dir).Trunk; trunk != "" {
		return trunk
	}
	return base
}

func trunkNoticeKey(dir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	return trunkNoticePrefix + hex.EncodeToString(sum[:6])
}

func trunkStep(state string, code string, trunk string) CleanupStepResult {
	return CleanupStepResult{Id: CleanupStepLocalTrunk, State: state, Code: code, Branch: trunk}
}

// gitDirOf is the git folder of a worktree (its `.git` folder, or the one its `.git` file names), "" when unreadable.
func gitDirOf(tree string) string {
	dotGit := filepath.Join(tree, ".git")
	info, err := os.Stat(dotGit)
	if err != nil {
		return ""
	}
	if info.IsDir() {
		return dotGit
	}
	data, err := os.ReadFile(dotGit)
	if err != nil {
		return ""
	}
	gitDir, ok := strings.CutPrefix(strings.TrimSpace(string(data)), "gitdir:")
	if !ok {
		return ""
	}
	gitDir = strings.TrimSpace(gitDir)
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(tree, gitDir)
	}
	return gitDir
}

func readTrimmed(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// busyWith tells whether an operation in a worktree holds the branch: a rebase or a bisect started from it (the
// worktree's HEAD is detached meanwhile), or a merge, cherry-pick, revert or bisect in the worktree that has it checked
// out.
func busyWith(gitDir string, ref string, checkedOut bool) bool {
	if gitDir == "" {
		return false
	}
	for _, dir := range []string{"rebase-merge", "rebase-apply"} {
		if readTrimmed(filepath.Join(gitDir, dir, "head-name")) == ref {
			return true
		}
	}
	if readTrimmed(filepath.Join(gitDir, "BISECT_START")) == strings.TrimPrefix(ref, "refs/heads/") {
		return true
	}
	if !checkedOut {
		return false
	}
	for _, name := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"} {
		if fileExists(filepath.Join(gitDir, name)) {
			return true
		}
	}
	return false
}

// localChanges reads the paths a worktree changed and has not committed, untracked files included (not ignored ones).
func (r *cleanupRun) localChanges(tree string) ([]string, error) {
	out, err := r.c.env.Run(r.ctx, tree, "git", "-c", "core.fsmonitor=false", "status", "--porcelain", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	var paths []string
	fields := strings.Split(string(out), "\x00")
	for i := 0; i < len(fields); i++ {
		entry := fields[i]
		if len(entry) < 4 {
			continue
		}
		paths = append(paths, entry[3:])
		// A rename or a copy is followed by the path it came from.
		if entry[0] == 'R' || entry[0] == 'C' {
			i++
			if i < len(fields) && fields[i] != "" {
				paths = append(paths, fields[i])
			}
		}
	}
	return paths, nil
}

// changesInTheWay are the local changes the fast-forward from local to remote would overwrite.
func (r *cleanupRun) changesInTheWay(tree string, local string, remote string) ([]string, error) {
	changes, err := r.localChanges(tree)
	if err != nil || len(changes) == 0 {
		return nil, err
	}
	out, err := r.c.env.Run(r.ctx, tree, "git", "diff", "--name-only", "-z", local, remote)
	if err != nil {
		return nil, err
	}
	touched := strings.Split(string(out), "\x00")
	var rtn []string
	for _, path := range changes {
		if slices.Contains(touched, path) {
			rtn = append(rtn, path)
		}
	}
	return rtn, nil
}

func (r *cleanupRun) syncLocalTrunk() CleanupStepResult {
	trunk := trunkOf(r.dir, r.pr.BaseRefName)
	if !reviewsession.ValidRef(trunk) {
		return trunkStep(CleanupStateSkipped, CleanupCodeNoLocalTrunk, trunk)
	}
	ref := "refs/heads/" + trunk
	local, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", ref)
	if err != nil || local == "" {
		return trunkStep(CleanupStateSkipped, CleanupCodeNoLocalTrunk, trunk)
	}
	remote, err := r.git(r.dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/"+trunk)
	if err != nil || remote == "" {
		return trunkStep(CleanupStateSkipped, CleanupCodeNoRemoteTrunk, trunk)
	}
	counts, err := r.git(r.dir, "rev-list", "--left-right", "--count", local+"..."+remote)
	if err != nil {
		return r.trunkFailed(trunkStep(CleanupStateFailed, "", trunk), err)
	}
	var ahead, behind int
	if _, err := fmt.Sscanf(counts, "%d %d", &ahead, &behind); err != nil {
		return r.trunkFailed(trunkStep(CleanupStateFailed, "", trunk), fmt.Errorf("git rev-list: unreadable answer %q", counts))
	}
	step := trunkStep(CleanupStateSkipped, CleanupCodeTrunkUpToDate, trunk)
	step.Count, step.Ahead = behind, ahead
	if behind == 0 {
		r.resolveTrunkNotice()
		return step
	}
	if ahead > 0 {
		step.Code = CleanupCodeTrunkLocalCommits
		return r.trunkRefused(step)
	}
	entries, err := r.worktreeEntries()
	if err != nil {
		return r.trunkFailed(step, err)
	}
	tree := ""
	for _, entry := range entries {
		checkedOut := entry[1] == ref
		if checkedOut {
			tree = entry[0]
		}
		if busyWith(gitDirOf(entry[0]), ref, checkedOut) {
			step.Code, step.Path = CleanupCodeTrunkInProgress, entry[0]
			return r.trunkRefused(step)
		}
	}
	if tree == "" {
		// Moves the ref only while it still points where it was read: a commit made meanwhile makes it fail.
		if _, err := r.git(r.dir, "update-ref", "-m", "molten: fast-forward to origin/"+trunk, ref, remote, local); err != nil {
			return r.trunkFailed(step, err)
		}
		return r.trunkUpdated(step)
	}
	step.Path = tree
	inTheWay, err := r.changesInTheWay(tree, local, remote)
	if err != nil {
		return r.trunkFailed(step, err)
	}
	if len(inTheWay) > 0 {
		step.Code, step.Names, step.NameCount = CleanupCodeTrunkChanges, firstN(inTheWay, trunkNamesShown), len(inTheWay)
		return r.trunkRefused(step)
	}
	if _, err := r.git(tree, "-c", "merge.autoStash=false", "merge", "--ff-only", "--no-autostash", "--quiet", remote); err != nil {
		// Git is the last guard: a change it saw and the check above did not still refuses the update.
		if changes, cerr := r.localChanges(tree); cerr == nil && len(changes) > 0 {
			step.Code, step.Names, step.NameCount = CleanupCodeTrunkChanges, firstN(changes, trunkNamesShown), len(changes)
			step.Error = err.Error()
			return r.trunkRefused(step)
		}
		return r.trunkFailed(step, err)
	}
	return r.trunkUpdated(step)
}

func firstN(names []string, n int) []string {
	if len(names) <= n {
		return names
	}
	return names[:n]
}

func (r *cleanupRun) trunkUpdated(step CleanupStepResult) CleanupStepResult {
	step.State, step.Code = CleanupStateDone, CleanupCodeTrunkUpdated
	r.resolveTrunkNotice()
	return step
}

func (r *cleanupRun) trunkRefused(step CleanupStepResult) CleanupStepResult {
	step.State = CleanupStateSkipped
	r.notifyTrunk(step)
	return step
}

func (r *cleanupRun) trunkFailed(step CleanupStepResult, err error) CleanupStepResult {
	step.State, step.Code = CleanupStateFailed, ""
	step.Error, step.ErrorText = err.Error(), uimsg.TextOf(err)
	r.notifyTrunk(step)
	return step
}

// trunkReasonText words why the local trunk was not updated: English for the logs and the code for the windows.
func trunkReasonText(step CleanupStepResult) (string, *uimsg.Text) {
	switch step.Code {
	case CleanupCodeTrunkLocalCommits:
		count := strconv.Itoa(step.Ahead)
		if step.Ahead == 1 {
			return "it has 1 commit origin does not have", uimsg.Make("notif.review.trunk.why.localcommitsOne")
		}
		return "it has " + count + " commits origin does not have", uimsg.Make("notif.review.trunk.why.localcommits", "count", count)
	case CleanupCodeTrunkChanges:
		names := strings.Join(step.Names, ", ")
		if more := step.NameCount - len(step.Names); more > 0 {
			return fmt.Sprintf("local changes in %s would be overwritten: %s and %d more", step.Path, names, more),
				uimsg.Make("notif.review.trunk.why.changesMore", "path", step.Path, "names", names, "more", strconv.Itoa(more))
		}
		return "local changes in " + step.Path + " would be overwritten: " + names,
			uimsg.Make("notif.review.trunk.why.changes", "path", step.Path, "names", names)
	case CleanupCodeTrunkInProgress:
		return "a rebase, merge, cherry-pick or bisect is in progress in " + step.Path,
			uimsg.Make("notif.review.trunk.why.inprogress", "path", step.Path)
	}
	return "git failed: " + step.Error, uimsg.Make("notif.review.trunk.why.failed", "detail", step.Error)
}

func (r *cleanupRun) notifyTrunk(step CleanupStepResult) {
	if r.c.env.Notify == nil {
		return
	}
	branch, count := step.Branch, strconv.Itoa(step.Count)
	reason, reasonText := trunkReasonText(step)
	message := uimsg.Make("notif.review.trunk.notUpdated", "branch", branch, "count", count).With("reason", reasonText)
	english := fmt.Sprintf("Local %s is %s commits behind origin and was not updated: %s.", branch, count, reason)
	if step.Count == 1 {
		message = uimsg.Make("notif.review.trunk.notUpdatedOne", "branch", branch).With("reason", reasonText)
		english = fmt.Sprintf("Local %s is 1 commit behind origin and was not updated: %s.", branch, reason)
	}
	where := step.Path
	if where == "" {
		where = r.dir
	}
	input := molten.NotificationInput{
		Key:         trunkNoticeKey(r.dir),
		Source:      "agent",
		Kind:        "warning",
		Title:       "Local " + branch + " not updated",
		TitleText:   uimsg.Make("notif.review.trunk.notUpdatedTitle", "branch", branch),
		Message:     english,
		MessageText: message,
		Actions: []molten.NotificationAction{{Id: "terminal", Label: "Open a terminal there", Kind: "gesture",
			Gesture: TerminalGesture, Args: map[string]any{"path": where}, Lasting: true,
			LabelText: uimsg.Make("notif.review.trunk.openTerminal")}},
	}
	if err := r.c.env.Notify(r.ctx, input); err != nil {
		log.Printf("%s %s: the notification could not be published: %v\n", logPrefix, input.Key, err)
	}
}

// resolveTrunkNotice: the local trunk is level with origin again, so an earlier refusal no longer holds.
func (r *cleanupRun) resolveTrunkNotice() {
	if r.c.env.ResolveNotices == nil {
		return
	}
	key := trunkNoticeKey(r.dir)
	if err := r.c.env.ResolveNotices(r.ctx, key); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("%s %s: the notification could not be resolved: %v\n", logPrefix, key, err)
	}
}
