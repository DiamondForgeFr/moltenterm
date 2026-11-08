// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package materials

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

// "Search past sessions" (FR-MAT-008): the materials published before the registry saw them live only in the
// transcripts the agents still keep. On the developer's request only, the project's transcripts (its worktrees' and
// sub-agents' included) are read again; each published page or production address they name goes through the same
// capture as live (guard, secret detection, limits). The republications of one address are one material: each source
// that still exists is a version, numbered after the publication it matches; a source already erased leaves a link.
// A session belongs to the project of the folder it started in, not to every project below its folder (#1816).

const maxRecoveredLinks = 2000

var recoverLock sync.Mutex

// ErrRecovering: a search of past sessions already runs.
var ErrRecovering = errors.New("a search of past sessions is already running")

// pastAgents: the agents whose transcripts a search reads; tests replace them.
var pastAgents = func() []companion.Adapter {
	var rtn []companion.Adapter
	for _, agent := range companion.SupportedAgents {
		if a := companion.AdapterFor(agent); a != nil {
			rtn = append(rtn, a)
		}
	}
	return rtn
}

// Recover searches the past sessions of a workspace's project.
func (r *Registry) Recover(workspaceId string) (molten.MaterialsRecovered, error) {
	info, err := r.workspaceInfo(workspaceId)
	if err != nil {
		return molten.MaterialsRecovered{}, err
	}
	key, folder := ProjectKey(info.Project)
	if folder == "" {
		return molten.MaterialsRecovered{}, errors.New("this workspace has no project folder")
	}
	if !recoverLock.TryLock() {
		return molten.MaterialsRecovered{}, ErrRecovering
	}
	defer recoverLock.Unlock()
	return r.recover(key, folder, pastAgents()), nil
}

// projectFolders: the main checkout and the linked worktrees its git folder lists (read, no git process runs).
func projectFolders(main string) []string {
	folders := []string{main}
	entries, err := os.ReadDir(filepath.Join(main, ".git", "worktrees"))
	if err != nil {
		return folders
	}
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(main, ".git", "worktrees", e.Name(), "gitdir"))
		if err != nil {
			continue
		}
		gitdir := strings.TrimSpace(string(data))
		if !filepath.IsAbs(gitdir) || filepath.Base(gitdir) != ".git" {
			continue
		}
		wt := filepath.Dir(gitdir)
		if !companion.FolderWithin(wt, folders) {
			folders = append(folders, wt)
		}
	}
	return folders
}

// pastPublication is one publication of an address, from one session.
type pastPublication struct {
	sig     companion.MaterialSignal
	session companion.MaterialBatch
	agent   string
}

func (r *Registry) recover(key string, folder string, adapters []companion.Adapter) molten.MaterialsRecovered {
	var out molten.MaterialsRecovered
	folders := projectFolders(folder)
	hosts := productionHosts()
	byLink := map[string][]pastPublication{}
	var order []string
	var named []pastPublication
	for _, adapter := range adapters {
		for _, path := range companion.PastSessionPaths(adapter, folders) {
			if !sessionOfProject(companion.PastSessionFolder(adapter, path), key) {
				continue
			}
			past, err := companion.ReadPastSession(adapter, path, hosts)
			if err != nil {
				continue
			}
			out.Sessions++
			for _, sig := range past.Batch.Signals {
				p := pastPublication{sig: sig, session: past.Batch, agent: adapter.Id()}
				if sig.Kind == companion.SignalLinks {
					named = append(named, p)
					continue
				}
				link, ok := CleanAddress(sig.Url)
				if !ok {
					continue
				}
				if _, seen := byLink[link]; !seen {
					if len(order) >= maxRecoveredLinks {
						continue
					}
					order = append(order, link)
				}
				byLink[link] = append(byLink[link], p)
			}
		}
	}
	found := map[string]bool{}
	for _, link := range order {
		id, created := r.recoverLink(key, folder, link, byLink[link])
		r.count(&out, key, id, created, found)
	}
	for _, p := range named {
		for _, link := range ProductionAddresses(p.sig.Links...) {
			if _, published := byLink[link]; published || len(found) >= maxRecoveredLinks {
				continue
			}
			c := pastCapture(key, folder, p)
			c.Source, c.Link, c.At = molten.MaterialSourceNamed, link, p.sig.At
			_, existed := r.store.match(key, "", link, "")
			m, _, err := r.capture(c)
			if err == nil {
				r.count(&out, key, m.Id, !existed, found)
			}
		}
	}
	return out
}

// sessionOfProject: the folder the session started in belongs to the project's drawer, by the rule that files a live
// capture (ProjectKey): a worktree maps back to its repository. Not "lies under the project's folder": a project folder
// that is not a repository (a parent such as ~/Projects) would take every repository under it, and a recovered
// material would show under the wrong project (#1816).
func sessionOfProject(cwd string, key string) bool {
	p, ok := placeSession(cwd)
	return ok && p.key == key
}

// placedSession is the project a session's folder belongs to: its drawer's key, its root folder, and whether that root
// is a repository.
type placedSession struct {
	key  string
	root string
	repo bool
}

// placeSession finds the project of a session's folder. A folder that no longer exists (a worktree since removed) is
// placed by the repository its nearest existing parent belongs to; without one it cannot be placed.
func placeSession(cwd string) (placedSession, bool) {
	if cwd == "" || !filepath.IsAbs(cwd) {
		return placedSession{}, false
	}
	dir := filepath.Clean(cwd)
	if _, err := os.Stat(dir); err == nil {
		return placeExisting(dir)
	}
	for {
		parent := filepath.Dir(dir)
		if parent == dir {
			return placedSession{}, false
		}
		dir = parent
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		if molten.FindGitRoot(dir) == "" {
			return placedSession{}, false
		}
		return placeExisting(dir)
	}
}

func placeExisting(dir string) (placedSession, bool) {
	key, root := ProjectKey(dir)
	if root == "" || key == molten.MaterialsNoProject {
		return placedSession{}, false
	}
	return placedSession{key: key, root: root, repo: molten.FindGitRoot(root) != ""}, true
}

func pastCapture(key string, folder string, p pastPublication) Capture {
	return Capture{Project: key, Folder: folder, Tool: p.agent, SessionId: p.session.SessionId, Subject: p.session.Subject, Ticket: p.session.Ticket}
}

// recoverLink captures the publications of one address: each source once, in the order they were published, with
// the version number of its latest publication and what the tool's result said of it (title, linked files). A frame-link
// record repeats the result it follows: it adds nothing but a source the result did not name.
func (r *Registry) recoverLink(key string, folder string, link string, pubs []pastPublication) (string, bool) {
	type source struct {
		latest  pastPublication
		version int
		last    int
	}
	sources := map[string]*source{}
	var paths []string
	for i, p := range pubs {
		path := p.sig.Path
		s := sources[path]
		if s == nil {
			s = &source{}
			sources[path] = s
			paths = append(paths, path)
		}
		if s.latest.sig.Kind == "" || p.sig.ArtifactId != "" || s.latest.sig.ArtifactId == "" {
			s.latest = p
		}
		s.version, s.last = max(s.version, p.sig.Version), i
	}
	sort.SliceStable(paths, func(i, j int) bool { return sources[paths[i]].last < sources[paths[j]].last })
	artifactId := artifactIdOf(pubs)
	_, existed := r.store.match(key, artifactId, link, "")
	id := ""
	for _, path := range paths {
		s := sources[path]
		sig := s.latest.sig
		c := pastCapture(key, folder, s.latest)
		c.Source, c.Link, c.ToolTitle, c.Linked, c.Sources, c.Version = molten.MaterialSourcePublished, link, sig.Title, sig.Files, sig.Sources, s.version
		c.ArtifactId, c.Path, c.At = artifactId, path, sig.At
		m, _, err := r.capture(c)
		if err == nil && m.Id != "" {
			id = m.Id
		}
	}
	return id, !existed && id != ""
}

func artifactIdOf(pubs []pastPublication) string {
	for i := len(pubs) - 1; i >= 0; i-- {
		if pubs[i].sig.ArtifactId != "" {
			return pubs[i].sig.ArtifactId
		}
	}
	return ""
}

// count adds a material found to the report, once.
func (r *Registry) count(out *molten.MaterialsRecovered, key string, id string, created bool, found map[string]bool) {
	if id == "" || found[id] {
		return
	}
	found[id] = true
	m, err := r.store.Get(key, id)
	if err != nil {
		return
	}
	out.Found++
	if created {
		out.New++
	}
	switch {
	case m.Copy == molten.MaterialCopyKept && len(m.Versions) > 0:
		out.Kept++
	case m.Copy == molten.MaterialCopyMissing:
		out.Gone++
	case m.Copy != "":
		out.NotCopied++
	}
}

// productionHosts are the known hosts, for the records a past session's reader decodes.
func productionHosts() []string {
	hostsLock.Lock()
	defer hostsLock.Unlock()
	var rtn []string
	for _, rule := range knownHosts {
		rtn = append(rtn, rule.Host)
	}
	return rtn
}
