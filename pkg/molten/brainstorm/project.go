// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mission"
)

// A clear brainstorm becomes a MoltenTerm project (FR-BOSS-010 AC15, DS-BOSS-010, #2250). The project card shows the
// preview (the full path, that git starts in it, the copy of the brainstorm, the workspace) and the developer's click
// sends the create, which checks everything again: it never trusts its preview. MoltenTerm alone builds the path, under
// the parent folder the developer chose, from a name of a strict pattern: no model text reaches a path or a command.
// git starts by the rule of mission.InitRepo (FR-SHELL-053), the copy goes to docs/brainstorm.md, never over a file and
// never committed, and the window then links the folder to a new or an existing workspace and says so (linked).

const (
	// The project's commands; must match frontend/moltenterm-shell/brainstorm/brainstorm-boot.ts.
	ProjectPreviewCommand = "moltenbrainstormprojectpreview"
	ProjectCreateCommand  = "moltenbrainstormprojectcreate"
	ProjectLinkedCommand  = "moltenbrainstormprojectlinked"

	ProjectDocsDir  = "docs"
	ProjectDocsName = "brainstorm.md"

	// The refusals a window says in one sentence, with Try again; must match brainstorm-project-model.ts.
	RefusalNotEmpty = "notempty"
	RefusalInRepo   = "inrepo"
	RefusalBadName  = "badname"
	RefusalNoParent = "noparent"
	RefusalNoBrief  = "nobrief"
	// RefusalPromoted: the brainstorm is a project already.
	RefusalPromoted = "promoted"

	projectGitTimeout = 30 * time.Second
)

// ProjectNamePattern is a project folder's name: the brief's slug, or what the developer typed instead. No separator,
// no leading dot, never "." or "..".
var ProjectNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// GitRunner runs git for the project's create; tests give their own.
type GitRunner = mission.Runner

func execGit(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	return mission.ExecRunner(ctx, dir, name, args...)
}

// GeargrimOffered: DiamondForge offers to take a brief to Geargrim (FR-BOSS-010 AC14). It does not in MoltenTerm 1.0.0:
// no Hand to Geargrim shows, no `geargrim` proposal is drawn, and no code calls DiamondForge. The brief file is the
// contract it will read (DS-BOSS-009).
func GeargrimOffered() bool {
	return false
}

// ProjectRequest names the project the card shows: the parent folder ("" for boss:projectsdir), the folder's name (""
// for the brief's slug), and the brainstorm it is made from (the state's swap and the folder's id, as the edits name it).
// A create also carries what the preview showed (Expect): the click acts only on that path.
type ProjectRequest struct {
	Parent string         `json:"parent,omitempty"`
	Name   string         `json:"name,omitempty"`
	Swap   *int64         `json:"swap,omitempty"`
	Id     string         `json:"id,omitempty"`
	Expect *ProjectExpect `json:"expect,omitempty"`
}

// ProjectExpect is the preview the developer saw before the click: the full path, and whether it was an empty folder
// already there.
type ProjectExpect struct {
	Path   string `json:"path"`
	Exists bool   `json:"exists,omitempty"`
}

// ProjectPreview is what the card shows before the click: the parent, the name, the full path, whether it is an empty
// folder already there (used as it is), the copy's place in it, and why it cannot be made.
type ProjectPreview struct {
	Parent  string `json:"parent"`
	Name    string `json:"name"`
	Path    string `json:"path,omitempty"`
	Exists  bool   `json:"exists,omitempty"`
	Docs    string `json:"docs"`
	Refusal string `json:"refusal,omitempty"`
}

type ProjectResult struct {
	State   State          `json:"state"`
	Preview ProjectPreview `json:"preview"`
	// Dir: the project folder the create made.
	Dir   string `json:"dir,omitempty"`
	Stale bool   `json:"stale,omitempty"`
	Error string `json:"error,omitempty"`
}

// LinkedRequest: the window linked the project folder to that workspace.
type LinkedRequest struct {
	Id        string `json:"id"`
	Dir       string `json:"dir"`
	Workspace string `json:"workspace"`
}

// UseProjects names the parent folder last chosen (boss:projectsdir, expanded) and how git runs.
func (s *Service) UseProjects(projectsDir func() string, run GitRunner) {
	s.lock.Lock()
	defer s.lock.Unlock()
	s.projectsDir = projectsDir
	if run != nil {
		s.run = run
	}
}

// ProjectsDir is boss:projectsdir with ~ expanded; "" when the developer has not chosen one yet.
func ProjectsDir(setting string, home string) string {
	value := strings.TrimSpace(setting)
	switch {
	case value == "":
		return ""
	case value == "~":
		return home
	case strings.HasPrefix(value, "~/"):
		return filepath.Join(home, value[2:])
	case !filepath.IsAbs(value):
		return ""
	}
	return filepath.Clean(value)
}

// projectSnapshotLocked is the open brainstorm the request names, copied for the work done outside the lock; false when
// it names another one, or none is open.
func (s *Service) projectSnapshotLocked(req ProjectRequest) (Saved, bool) {
	if !s.open || s.session == nil || !s.sameBrainstormLocked(req.Swap, req.Id) {
		return Saved{}, false
	}
	snap := *s.session
	snap.Turns = append([]Turn{}, s.session.Turns...)
	snap.Graph.Nodes = append([]Node{}, s.session.Graph.Nodes...)
	snap.Graph.Links = append([]Link{}, s.session.Graph.Links...)
	snap.History = nil
	return snap, true
}

func (s *Service) snapshot(req ProjectRequest) (Saved, State, bool, func() string, GitRunner) {
	s.lock.Lock()
	defer s.lock.Unlock()
	snap, ok := s.projectSnapshotLocked(req)
	return snap, s.stateLocked(), ok, s.projectsDir, s.run
}

func emptyDir(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

// checkProject is the preview of the project folder, with the first reason it cannot be made.
func checkProject(ctx context.Context, run GitRunner, req ProjectRequest, setting string, slug string) ProjectPreview {
	parent := strings.TrimSpace(req.Parent)
	if parent == "" {
		parent = setting
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = slug
	}
	p := ProjectPreview{Parent: parent, Name: name, Docs: path.Join(ProjectDocsDir, ProjectDocsName)}
	if parent == "" || !filepath.IsAbs(parent) {
		p.Refusal = RefusalNoParent
		return p
	}
	parent = filepath.Clean(parent)
	p.Parent = parent
	if info, err := os.Stat(parent); err != nil || !info.IsDir() {
		p.Refusal = RefusalNoParent
		return p
	}
	if !ProjectNamePattern.MatchString(name) || strings.HasSuffix(name, ".") {
		p.Refusal = RefusalBadName
		return p
	}
	p.Path = filepath.Join(parent, name)
	if filepath.Dir(p.Path) != parent {
		p.Path = ""
		p.Refusal = RefusalBadName
		return p
	}
	entry, err := os.Lstat(p.Path)
	switch {
	case err == nil && !entry.IsDir():
		p.Refusal = RefusalNotEmpty
		return p
	case err == nil:
		empty, err := emptyDir(p.Path)
		if err != nil || !empty {
			p.Refusal = RefusalNotEmpty
			return p
		}
		p.Exists = true
	case !errors.Is(err, os.ErrNotExist):
		p.Refusal = ReasonFailed
		return p
	}
	if mission.InsideRepo(ctx, run, parent) {
		p.Refusal = RefusalInRepo
	}
	return p
}

// ProjectPreview is the card's preview for the open brainstorm's brief: nothing is made.
func (s *Service) ProjectPreview(req ProjectRequest) ProjectResult {
	snap, state, ok, projectsDir, run := s.snapshot(req)
	if !ok {
		return ProjectResult{State: state, Stale: true}
	}
	if snap.Brief == nil {
		return ProjectResult{State: state, Error: RefusalNoBrief}
	}
	ctx, cancel := context.WithTimeout(context.Background(), projectGitTimeout)
	defer cancel()
	preview := checkProject(ctx, run, req, projectsDir(), snap.Brief.Slug)
	return ProjectResult{State: state, Preview: preview}
}

// writeExclusive writes a file that must not exist yet: an existing one is never replaced.
func writeExclusive(file string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(file)
	}
	return err
}

// madeParts are what a create made, and only those: a create that fails half-way takes back these alone.
type madeParts struct {
	dir string
	// folder: this create made the project folder; git: its .git; docs: its docs folder.
	folder bool
	git    bool
	docs   bool
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// undo takes back what a create that failed half-way made: git's folder when this create made it, the docs folder and
// the project folder only while empty. A file this create did not write is never removed, and nothing is ever removed
// whole but the .git it made.
func (m madeParts) undo() {
	if m.git {
		_ = os.RemoveAll(filepath.Join(m.dir, ".git"))
	}
	if m.docs {
		_ = os.Remove(filepath.Join(m.dir, ProjectDocsDir))
	}
	if m.folder {
		_ = os.Remove(m.dir)
	}
}

// ProjectCreate makes the project on the developer's click (AC15): the folder, git in it, then the copy of the
// brainstorm. One create runs at a time. It acts only on the path the preview showed: when the path, or whether an
// empty folder stands there, is no longer what the developer saw, it answers stale and makes nothing, and the card
// previews again. The brainstorm becomes promoted, its folder named in promotedto; a create that fails takes back what
// it made and says why.
func (s *Service) ProjectCreate(req ProjectRequest) ProjectResult {
	s.projectLock.Lock()
	defer s.projectLock.Unlock()
	snap, state, ok, projectsDir, run := s.snapshot(req)
	if !ok {
		return ProjectResult{State: state, Stale: true}
	}
	if snap.Brief == nil {
		return ProjectResult{State: state, Error: RefusalNoBrief}
	}
	if snap.Info.State == StatePromoted {
		return ProjectResult{State: state, Error: RefusalPromoted}
	}
	ctx, cancel := context.WithTimeout(context.Background(), projectGitTimeout)
	defer cancel()
	preview := checkProject(ctx, run, req, projectsDir(), snap.Brief.Slug)
	if req.Expect == nil || req.Expect.Path != preview.Path || req.Expect.Exists != preview.Exists {
		return ProjectResult{State: state, Preview: preview, Stale: true}
	}
	failed := func(reason string) ProjectResult {
		return ProjectResult{State: s.State(), Preview: preview, Error: reason}
	}
	if preview.Refusal != "" {
		return failed(preview.Refusal)
	}
	made := madeParts{dir: preview.Path}
	if !preview.Exists {
		if err := os.Mkdir(preview.Path, 0o755); err != nil {
			if errors.Is(err, os.ErrExist) {
				preview.Refusal = RefusalNotEmpty
				return failed(RefusalNotEmpty)
			}
			s.logf("[brainstorm] a project folder could not be made\n")
			return failed(ReasonFailed)
		}
		made.folder = true
	}
	gitBefore := exists(filepath.Join(preview.Path, ".git"))
	err := mission.InitRepo(ctx, run, preview.Path)
	made.git = !gitBefore && exists(filepath.Join(preview.Path, ".git"))
	if err != nil {
		made.undo()
		if errors.Is(err, mission.ErrInsideRepo) {
			preview.Refusal = RefusalInRepo
			return failed(RefusalInRepo)
		}
		// Never git's words: they name the folder, which holds the brief's slug.
		s.logf("[brainstorm] git could not start in a new project folder\n")
		return failed(ReasonFailed)
	}
	at := s.now().UnixMilli()
	copyText := BrainstormCopy(snap, *snap.Brief, at)
	made.docs = !exists(filepath.Join(preview.Path, ProjectDocsDir))
	if err := writeExclusive(filepath.Join(preview.Path, ProjectDocsDir, ProjectDocsName), []byte(copyText)); err != nil {
		made.undo()
		s.logf("[brainstorm] the copy of a brainstorm could not be written in its project\n")
		return failed(ReasonFailed)
	}
	version := s.promote(snap, preview.Path, at)
	s.tellChanged(version)
	return ProjectResult{State: s.State(), Preview: preview, Dir: preview.Path}
}

// promote marks the brainstorm promoted, in the session when it is still the one open, else in its folder.
func (s *Service) promote(snap Saved, dir string, at int64) int64 {
	s.lock.Lock()
	defer s.lock.Unlock()
	promotion := &Promotion{Dir: dir, At: at}
	if s.session != nil && s.session.Info.Id == snap.Info.Id && s.session.Dir == snap.Dir {
		s.session.Info.State = StatePromoted
		s.session.Info.PromotedTo = promotion
		s.saveLocked(at)
		s.listRev++
		return s.changedLocked()
	}
	saved, err := s.store.Load(snap.Dir)
	if err != nil {
		s.logf("[brainstorm] a promoted brainstorm could not be read back: %s\n", reasonOf(err))
		return 0
	}
	saved.Info.State = StatePromoted
	saved.Info.PromotedTo = promotion
	saved.Info.Updated = at
	if err := s.store.Save(saved); err != nil {
		s.logf("[brainstorm] a promoted brainstorm could not be saved: %s\n", reasonOf(err))
		return 0
	}
	s.listRev++
	return s.changedLocked()
}

// ProjectLinked keeps the workspace the window linked the project folder to, in promotedto.
func (s *Service) ProjectLinked(req LinkedRequest) ActionResult {
	rtn, version := s.linked(req)
	s.tellChanged(version)
	return rtn
}

func (s *Service) linked(req LinkedRequest) (ActionResult, int64) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if s.session == nil || s.session.Info.Id != req.Id || s.session.Info.PromotedTo == nil {
		return ActionResult{State: s.stateLocked(), Error: ReasonUnknown}, 0
	}
	if s.session.Info.PromotedTo.Dir != filepath.Clean(req.Dir) || !workspaceIdPattern.MatchString(req.Workspace) {
		return ActionResult{State: s.stateLocked(), Error: ReasonInvalid}, 0
	}
	s.session.Info.PromotedTo.Workspace = req.Workspace
	s.saveLocked(s.now().UnixMilli())
	s.listRev++
	version := s.changedLocked()
	summary := summaryOf(s.session.Dir, s.session.Info, len(s.session.Turns))
	return ActionResult{State: s.stateLocked(), Summary: &summary}, version
}

// BrainstormCopy is docs/brainstorm.md: the brainstorm as it stood when it became the project, for the developer and
// the agents that build it. Its title, the brief, the thought's outline, then the conversation.
func BrainstormCopy(saved Saved, brief ProjectBrief, at int64) string {
	words := wordsFor(brief.Language)
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n_"+words.Copy+"_\n", mdLine(saved.Info.Title), day(at))
	fmt.Fprintf(&b, "\n## %s\n\n> %s\n", mdLine(brief.Name), mdLine(brief.Pitch))
	briefBody(&b, brief, words, "###")
	if len(saved.Graph.Nodes) > 0 {
		fmt.Fprintf(&b, "\n## %s\n\n", words.Thought)
		children := map[string][]Node{}
		for _, n := range saved.Graph.Nodes {
			if n.Id != saved.Graph.Centre {
				children[n.From] = append(children[n.From], n)
			}
		}
		var walk func(id string, depth int)
		walk = func(id string, depth int) {
			for _, n := range children[id] {
				fmt.Fprintf(&b, "%s- %s%s\n", strings.Repeat("  ", depth), kindLead(words, n.Kind), mdLine(n.Text))
				walk(n.Id, depth+1)
			}
		}
		if centre, ok := saved.Graph.node(saved.Graph.Centre); ok {
			fmt.Fprintf(&b, "- **%s**\n", mdLine(centre.Text))
			walk(centre.Id, 1)
		}
	}
	if len(saved.Turns) > 0 {
		// An agent that builds the project reads this file: the talk is data, as in his resume brief, and no line of it
		// opens an HTML tag.
		fmt.Fprintf(&b, "\n## %s\n\n_%s_\n", words.Conversation, words.ConversationNote)
		for _, turn := range saved.Turns {
			who := words.You
			if turn.Role == RoleBrokk {
				who = words.Brokk
			}
			fmt.Fprintf(&b, "\n**%s**\n\n", who)
			for _, line := range strings.Split(strings.TrimSpace(turn.Text), "\n") {
				fmt.Fprintf(&b, "> %s\n", strings.ReplaceAll(line, "<", "&lt;"))
			}
		}
	}
	return b.String()
}

func kindLead(words briefWords, kind string) string {
	label := words.Kinds[kind]
	if label == "" {
		return ""
	}
	return "_" + label + "_ · "
}
