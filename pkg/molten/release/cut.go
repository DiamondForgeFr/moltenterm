// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The cut in two halves, as Notulia's release.sh --prepare / --finalize, so the public notes can be read and edited
// between them (in Mission Control, before the click that pushes the tag).

// checkNumber refuses a tag that is not the next one of its channel: a candidate number already passed or skipped, a
// public version already released or not above the last public release.
func (p *Project) checkNumber(v versions.Version, tags []string) error {
	if v.IsRc() {
		publicTag := p.Rules.Tag(v.Base())
		for _, tag := range tags {
			if tag == publicTag {
				return fmt.Errorf("%s is already released: its candidates are closed", tag)
			}
		}
		if next := p.Rules.NextRc(v.Base(), tags); next != v.Rc {
			return fmt.Errorf("the next release candidate of %s is %s, not %s", v.Base(), p.Rules.Tag(v.Base().WithRc(next)), p.Rules.Tag(v))
		}
		return nil
	}
	if last := p.Rules.LastPublic(tags); last != "" {
		lastVersion, _ := p.Rules.ReleaseOf(last)
		if versions.Compare(v, lastVersion) <= 0 {
			return fmt.Errorf("%s is not above the last public release, %s", p.Rules.Tag(v), last)
		}
	}
	return nil
}

// Prepare sets up the cut of a tag in the release worktree, on the release branch as origin has it: the version
// written in every declared file (read back), the notes drafted unless the release branch already carries them. Nothing
// is committed: Finalize does it once the notes are reviewed.
func (e *Env) Prepare(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, channel, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	if len(p.Files) == 0 {
		return fmt.Errorf("%s declares no versions.files: nothing would carry %s", p.Root, tag)
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	if where := e.tagTaken(ctx, p.Root, tag); where != "" {
		return fmt.Errorf("%s already exists %s: nothing was changed", tag, where)
	}
	if err := p.checkNumber(v, e.releaseTags(ctx, p.Root, p)); err != nil {
		return err
	}
	start := "origin/" + p.Release
	if e.revParse(ctx, p.Root, start) == "" {
		return fmt.Errorf("origin has no %s branch: promote %s first", p.Release, p.Trunk)
	}
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return err
	}
	if err := e.resetWorktree(ctx, p.Root, wt, start); err != nil {
		return err
	}
	e.printf("Preparing %s (%s) in %s, on %s.\n", tag, channel, wt, start)
	if err := versions.WriteVersion(wt, p.Files, v.String()); err != nil {
		return fmt.Errorf("the version bump did not take: %w", err)
	}
	paths := make([]string, 0, len(p.Files))
	for _, f := range p.Files {
		paths = append(paths, f.Path)
	}
	e.printf("Version %s written in %s.\n", v, strings.Join(paths, ", "))

	notesRel := p.NotesFile(tag)
	notesPath := filepath.Join(wt, notesRel)
	if !insideDir(wt, notesPath) {
		return fmt.Errorf("versions.notes (%s) leaves the project", p.Notes)
	}
	if existing, err := os.ReadFile(notesPath); err == nil && strings.TrimSpace(string(existing)) != "" {
		e.printf("Notes kept: %s is already on %s.\n", notesRel, p.Release)
	} else {
		facts, err := e.gatherNotesFacts(ctx, wt, p, tag, v)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(notesPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(notesPath, []byte(DraftNotes(facts)), 0644); err != nil {
			return err
		}
		e.printf("Notes drafted from %d commit subject(s) since %s.\n", len(facts.Subjects), facts.sinceLabel())
	}
	e.printf("\n%s prepared, nothing committed. Review the notes, then finalize to commit, tag and push.\n", tag)
	e.printf("%s%s\n", NotesMarker, notesPath)
	return nil
}

func insideDir(dir string, path string) bool {
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// releaseFiles are the paths a prepared tree may change: the version files and the tag's notes.
func (p *Project) releaseFiles(tag string) map[string]bool {
	allowed := map[string]bool{filepath.ToSlash(p.NotesFile(tag)): true}
	for _, f := range p.Files {
		allowed[filepath.ToSlash(filepath.Clean(f.Path))] = true
	}
	return allowed
}

// changedPaths lists the paths git status reports, untracked files included, as git writes them (slash-separated).
func (e *Env) changedPaths(ctx context.Context, wt string) ([]string, error) {
	out, err := e.run(ctx, wt, "git", "status", "--porcelain", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	var paths []string
	entries := strings.Split(string(out), "\x00")
	for i := 0; i < len(entries); i++ {
		entry := entries[i]
		if len(entry) < 4 {
			continue
		}
		paths = append(paths, entry[3:])
		// A rename or copy is followed by its source.
		if entry[0] == 'R' || entry[0] == 'C' {
			i++
		}
	}
	return paths, nil
}

// Finalize commits what Prepare left, tags it and pushes the release branch and the tag atomically, after checking
// the prepared tree again: the notes may have been edited, and the release branch may have moved meanwhile. The
// version is read back from the files, never recomputed: a tag cut meanwhile must not renumber what the notes were
// written for.
func (e *Env) Finalize(ctx context.Context, tag string) error {
	p, err := e.LoadProject(ctx)
	if err != nil {
		return err
	}
	v, channel, err := p.releaseOf(tag)
	if err != nil {
		return err
	}
	unlock, err := e.lock(ctx, p.Root)
	if err != nil {
		return err
	}
	defer unlock()
	wt, err := e.ReleaseWorktree(ctx, p.Root)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(wt, ".git")); err != nil {
		return fmt.Errorf("nothing is prepared: %s does not exist, prepare %s first", wt, tag)
	}
	if err := e.fetch(ctx, p.Root); err != nil {
		return err
	}
	if where := e.tagTaken(ctx, p.Root, tag); where != "" {
		return fmt.Errorf("%s already exists %s: nothing was committed", tag, where)
	}
	head := e.revParse(ctx, wt, "HEAD")
	if head == "" || head != e.revParse(ctx, p.Root, "origin/"+p.Release) {
		return fmt.Errorf("%s moved since the preparation (or nothing is prepared): prepare %s again", p.Release, tag)
	}
	for _, f := range p.Files {
		found, err := versions.ReadFileVersions(wt, f)
		if err != nil {
			return fmt.Errorf("%s: %w; prepare %s again", f.Path, err, tag)
		}
		for _, got := range found {
			if got != v.String() {
				return fmt.Errorf("the prepared tree reads %s in %s, not %s: prepare %s again", got, f.Path, v, tag)
			}
		}
	}
	allowed := p.releaseFiles(tag)
	changed, err := e.changedPaths(ctx, wt)
	if err != nil {
		return err
	}
	unexpected := []string{}
	for _, path := range changed {
		if !allowed[path] {
			unexpected = append(unexpected, path)
		}
	}
	if len(unexpected) > 0 {
		return fmt.Errorf("the prepared tree holds more than the release (%s): prepare %s again", strings.Join(unexpected, ", "), tag)
	}
	notesRel := p.NotesFile(tag)
	if !insideDir(wt, filepath.Join(wt, notesRel)) {
		return fmt.Errorf("versions.notes (%s) leaves the project", p.Notes)
	}
	notes, err := os.ReadFile(filepath.Join(wt, notesRel))
	if err != nil || strings.TrimSpace(string(notes)) == "" {
		return fmt.Errorf("%s is missing or empty: write the notes, or prepare %s again", notesRel, tag)
	}
	addArgs := []string{"add", "--"}
	for path := range allowed {
		if _, err := os.Stat(filepath.Join(wt, path)); err == nil {
			addArgs = append(addArgs, path)
		}
	}
	if _, err := e.git(ctx, wt, addArgs...); err != nil {
		return err
	}
	msg := fmt.Sprintf("chore(release): %s (%s)", tag, channel)
	if _, err := e.git(ctx, wt, "commit", "--quiet", "-m", msg); err != nil {
		return fmt.Errorf("could not commit the release: %w", err)
	}
	if _, err := e.git(ctx, wt, "tag", tag); err != nil {
		e.git(ctx, wt, "reset", "--quiet", "--soft", "HEAD~1")
		return fmt.Errorf("could not tag the release: %w", err)
	}
	// --atomic: without it the two refs go independently, and a refused tag would leave the release branch carrying a
	// release commit with no tag and no build.
	if _, err := e.git(ctx, wt, "push", "--quiet", "--atomic", "origin", "HEAD:refs/heads/"+p.Release, "refs/tags/"+tag); err != nil {
		e.git(ctx, wt, "tag", "-d", tag)
		e.git(ctx, wt, "reset", "--quiet", "--soft", "HEAD~1")
		return fmt.Errorf("the push was refused, nothing reached origin and the prepared tree is back as it was (finalize again, or prepare again if %s moved): %w", p.Release, err)
	}
	commit := e.revParse(ctx, wt, "HEAD")
	e.printf("%s committed (%s), tagged and pushed with %s.\n", tag, commit[:min(7, len(commit))], p.Release)
	if channel == versions.ChannelRc {
		e.printf("A release candidate: the release workflow builds it and publishes it as a prerelease, offered to nobody.\n")
	} else {
		e.printf("A public release: the release workflow builds it and leaves a draft; publishing it makes it the latest release.\n")
	}
	e.printf("Carry the release commit back to %s next (molten release sync-back %s).\n", p.Trunk, tag)
	return nil
}
