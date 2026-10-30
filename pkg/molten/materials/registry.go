// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package materials is the materials registry (FR-MAT-001, DS-MAT-001 to DS-MAT-004): what agents produce for the
// developer outside the repository and show them (published, named in an answer, declared), kept per project on this
// computer in MoltenTerm's data folder, never in a repository, never sent anywhere (NFR-MAT-001).
//
// Detection runs in wavesrv next to the task checkpoint: the checkpoint's updater hands over the signals of the session
// records its reader already holds (checkpoint.MaterialFeed), so no transcript is followed twice and the agents' hooks
// do not change (FR-PERF-012, NFR-MAT-003). A single worker copies in the background.
package materials

import (
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentcontinuity/checkpoint"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

const (
	// Feeds waiting for the worker; past this the oldest go (a burst the worker could not keep up with).
	maxQueue = 2000
	// The block contexts are read again after this long (a workspace linked to a project meanwhile).
	contextTTL = time.Minute
	// A terminal's output read per look, and at first sight (what it printed before).
	terminalReadMax = 256 * 1024
	// The work files a drawer remembers; the oldest go first.
	maxWorkFiles = 500
	// The materials of a turn recopied at its end.
	maxTurnMaterials = 100
)

var (
	ansiRegex    = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]`)
	controlRegex = regexp.MustCompile(`[\x00-\x1f\x7f]`)
)

// BlockInfo is what the registry needs of a pane: its workspace, its project folder ("" for none), whether it is a
// remote terminal.
type BlockInfo struct {
	WorkspaceId string
	Project     string
	Remote      bool
}

type blockCtx struct {
	info    BlockInfo
	key     string
	folder  string
	readAt  time.Time
	session companion.MaterialBatch
	// turn: the materials seen in the current turn that may be lost, recopied at its end.
	turn map[string]bool
	// termOffset: how far its terminal's output was read.
	termOffset int64
	termSeen   bool
}

type Registry struct {
	store  *Store
	guard  guard
	home   string
	limits Limits

	lock sync.Mutex
	// Guarded by lock.
	queue  []checkpoint.MaterialFeed
	blocks map[string]*blockCtx
	busy   bool
	wake   chan struct{}

	// Injected; replaced in tests.
	blockInfo   func(blockId string) (BlockInfo, error)
	workspaceOf func(workspaceId string) (BlockInfo, error)
	runOf       func(blockId string) (molten.AgentRunInfo, bool)
	readTerm    func(blockId string, from int64, max int64) ([]byte, int64, int64, error)
	outside     func(path string) bool
	now         func() time.Time
}

// MakeRegistry is a registry over a store; own lists MoltenTerm's own folders (never copied).
func MakeRegistry(store *Store, home string, own []string) *Registry {
	return &Registry{
		store:   store,
		guard:   makeGuard(home, append(own, store.Root())),
		home:    home,
		limits:  DefaultLimits(),
		blocks:  map[string]*blockCtx{},
		wake:    make(chan struct{}, 1),
		outside: gitOutside,
		now:     time.Now,
	}
}

func (r *Registry) Store() *Store {
	return r.store
}

func (r *Registry) Limits() Limits {
	return r.limits
}

// Feed is the checkpoint updater's sink: it queues and returns at once.
func (r *Registry) Feed(feed checkpoint.MaterialFeed) {
	r.lock.Lock()
	r.queue = append(r.queue, feed)
	if len(r.queue) > maxQueue {
		r.queue = append([]checkpoint.MaterialFeed(nil), r.queue[len(r.queue)-maxQueue:]...)
	}
	r.lock.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *Registry) take() []checkpoint.MaterialFeed {
	r.lock.Lock()
	defer r.lock.Unlock()
	q := r.queue
	r.queue = nil
	r.busy = len(q) > 0
	return q
}

func (r *Registry) setIdle() {
	r.lock.Lock()
	defer r.lock.Unlock()
	if len(r.queue) == 0 {
		r.busy = false
	}
}

// Idle tells whether every feed was processed (tests wait for it).
func (r *Registry) Idle() bool {
	r.lock.Lock()
	defer r.lock.Unlock()
	return len(r.queue) == 0 && !r.busy
}

// Run processes the feeds until stop is closed.
func (r *Registry) Run(stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case <-r.wake:
		}
		for {
			feeds := r.take()
			if len(feeds) == 0 {
				break
			}
			for _, f := range feeds {
				r.process(f)
			}
			r.setIdle()
		}
	}
}

func (r *Registry) process(feed checkpoint.MaterialFeed) {
	defer func() {
		panichandler.PanicHandler("molten:materials:process", recover())
	}()
	bc := r.context(feed.BlockId)
	if bc == nil {
		return
	}
	if feed.Batch.Seq > 0 || len(feed.Batch.Signals) > 0 {
		r.setSession(feed.BlockId, feed.Batch)
	}
	for _, sig := range feed.Batch.Signals {
		r.signal(feed, bc, sig)
	}
	if feed.Unlinked {
		r.scanTerminal(feed, bc)
	}
	if feed.TurnEnded {
		r.endTurn(feed.BlockId, bc)
	}
}

func (r *Registry) setSession(blockId string, b companion.MaterialBatch) {
	r.lock.Lock()
	defer r.lock.Unlock()
	if bc := r.blocks[blockId]; bc != nil {
		b.Signals = nil
		bc.session = b
	}
}

// context is a pane's project and agent, read once per contextTTL.
func (r *Registry) context(blockId string) *blockCtx {
	if blockId == "" {
		return nil
	}
	r.lock.Lock()
	bc := r.blocks[blockId]
	fresh := bc != nil && r.now().Sub(bc.readAt) < contextTTL
	r.lock.Unlock()
	if fresh {
		return bc
	}
	var info BlockInfo
	if r.blockInfo != nil {
		got, err := r.blockInfo(blockId)
		if err != nil {
			return bc
		}
		info = got
	}
	key, folder := ProjectKey(info.Project)
	r.lock.Lock()
	defer r.lock.Unlock()
	bc = r.blocks[blockId]
	if bc == nil {
		bc = &blockCtx{turn: map[string]bool{}}
		r.blocks[blockId] = bc
	}
	bc.info, bc.key, bc.folder, bc.readAt = info, key, folder, r.now()
	return bc
}

// ForgetBlock drops a closed pane's context.
func (r *Registry) ForgetBlock(blockId string) {
	r.lock.Lock()
	defer r.lock.Unlock()
	delete(r.blocks, blockId)
}

// who fills a capture with the pane's project, agent and session.
func (r *Registry) who(blockId string, agent string, bc *blockCtx) Capture {
	r.lock.Lock()
	session := bc.session
	key, folder, wsId := bc.key, bc.folder, bc.info.WorkspaceId
	r.lock.Unlock()
	c := Capture{Project: key, Folder: folder, Tool: agent, SessionId: session.SessionId, Subject: session.Subject, Ticket: session.Ticket, WorkspaceId: wsId, BlockId: blockId}
	if r.runOf != nil {
		if run, ok := r.runOf(blockId); ok {
			c.Agent = run.FirstName
			if c.Tool == "" {
				c.Tool = run.Agent
			}
		}
	}
	return c
}

func (r *Registry) signal(feed checkpoint.MaterialFeed, bc *blockCtx, sig companion.MaterialSignal) {
	remote := bc.info.Remote
	switch sig.Kind {
	case companion.SignalPublished:
		c := r.who(feed.BlockId, feed.Agent, bc)
		c.Source, c.Link, c.ToolTitle, c.ArtifactId, c.Linked, c.Sources = molten.MaterialSourcePublished, sig.Url, sig.Title, sig.ArtifactId, sig.Files, sig.Sources
		if !remote {
			c.Path = sig.Path
		}
		r.keep(feed.BlockId, bc, c)
	case companion.SignalLinks:
		for _, link := range ProductionAddresses(sig.Links...) {
			c := r.who(feed.BlockId, feed.Agent, bc)
			c.Source, c.Link = molten.MaterialSourceNamed, link
			r.keep(feed.BlockId, bc, c)
		}
	case companion.SignalAnswer:
		if remote {
			return
		}
		for _, path := range existingMaterialPaths(NamedPaths(sig.Text, r.home)) {
			c := r.who(feed.BlockId, feed.Agent, bc)
			c.Source, c.Path = molten.MaterialSourceNamed, path
			r.keep(feed.BlockId, bc, c)
		}
	case companion.SignalWritten:
		if !remote {
			r.workFile(feed, bc, sig)
		}
	case companion.SignalTurnEnd:
		r.endTurn(feed.BlockId, bc)
	}
}

// keep captures a sighting and remembers it for the end-of-turn recopy when it may be lost.
func (r *Registry) keep(blockId string, bc *blockCtx, c Capture) {
	m, _, err := r.capture(c)
	if err != nil {
		if !errors.Is(err, ErrNotMaterial) {
			log.Printf("molten: material not kept: %v\n", err)
		}
		return
	}
	if m.Id == "" || !m.MayBeLost || m.Original == "" {
		return
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	if len(bc.turn) < maxTurnMaterials {
		bc.turn[m.Id] = true
	}
}

// endTurn copies again the turn's materials that may be lost: a page often receives its captures after it was shown.
func (r *Registry) endTurn(blockId string, bc *blockCtx) {
	r.lock.Lock()
	ids := make([]string, 0, len(bc.turn))
	for id := range bc.turn {
		ids = append(ids, id)
	}
	bc.turn = map[string]bool{}
	key := bc.key
	r.lock.Unlock()
	for _, id := range ids {
		m, err := r.store.Get(key, id)
		if err != nil || m.Original == "" || (m.Copy != molten.MaterialCopyKept && m.Copy != molten.MaterialCopyMissing) {
			continue
		}
		c := Capture{Project: key, Folder: bc.folder, Source: m.Source, Path: m.Original, Link: m.Link, ArtifactId: m.ArtifactId, Recopy: true, Tool: m.Tool, Agent: m.Agent, SessionId: m.SessionId, Subject: m.Subject, Ticket: m.Ticket}
		if last := len(m.Versions); last > 0 {
			c.Linked = r.versionFiles(m)
		}
		if _, _, err := r.capture(c); err != nil && !errors.Is(err, ErrNotMaterial) {
			log.Printf("molten: material %s not copied again: %v\n", id, err)
		}
	}
}

// versionFiles lists the linked files of a material's latest copy, so a recopy keeps those the page no longer names.
func (r *Registry) versionFiles(m molten.Material) []string {
	v := m.Versions[len(m.Versions)-1]
	dir := filepath.Join(r.store.drawerDir(m.Project), itemsDir, m.Id, v.Dir)
	var rtn []string
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || len(rtn) >= r.limits.MaxLinked {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err == nil && rel != v.Main {
			rtn = append(rtn, filepath.ToSlash(rel))
		}
		return nil
	})
	return rtn
}

// workFile records a file the agent created: listed, never copied by itself (AC2).
func (r *Registry) workFile(feed checkpoint.MaterialFeed, bc *blockCtx, sig companion.MaterialSignal) {
	path := sig.Path
	if path == "" || !filepath.IsAbs(path) {
		return
	}
	kind := KindOfPath(path)
	if kind == "" {
		return
	}
	real, _, err := r.guard.resolveFile(path)
	if err != nil || !r.outside(real) {
		return
	}
	c := r.who(feed.BlockId, feed.Agent, bc)
	r.store.addWorkFile(c.Project, c.Folder, molten.MaterialWorkFile{Path: real, At: sig.At, Kind: kind, Agent: c.Agent, Tool: c.Tool, SessionId: c.SessionId, Ticket: c.Ticket, MayBeLost: r.guard.mayBeLost(real)})
}

// scanTerminal reads what an agent without a transcript printed since the last look, for production addresses
// (signal 2 for an agent without an adapter, and the only signal of a remote terminal).
func (r *Registry) scanTerminal(feed checkpoint.MaterialFeed, bc *blockCtx) {
	if r.readTerm == nil {
		return
	}
	if companion.AdapterFor(feed.Agent) != nil && !bc.info.Remote {
		return
	}
	r.lock.Lock()
	from, seen := bc.termOffset, bc.termSeen
	r.lock.Unlock()
	data, _, end, err := r.readTerm(feed.BlockId, from, terminalReadMax)
	if err != nil {
		return
	}
	r.lock.Lock()
	bc.termOffset, bc.termSeen = end, true
	r.lock.Unlock()
	if !seen && len(data) == 0 {
		return
	}
	text := string(data)
	// A hyperlink's address is inside its escape sequence (OSC 8): read once with the control characters as spaces,
	// once without the sequences (an address the colours cut).
	for _, link := range ProductionAddresses(controlRegex.ReplaceAllString(text, " "), ansiRegex.ReplaceAllString(text, "")) {
		c := r.who(feed.BlockId, feed.Agent, bc)
		c.Source, c.Link = molten.MaterialSourceNamed, link
		r.keep(feed.BlockId, bc, c)
	}
}

// addWorkFile remembers a work file of a drawer; one the drawer already keeps as a material is not one.
func (s *Store) addWorkFile(key string, folder string, w molten.MaterialWorkFile) {
	s.lock.Lock()
	defer s.lock.Unlock()
	d, err := s.loadLocked(key)
	if err != nil {
		return
	}
	for _, m := range d.index.Materials {
		if m.Original == w.Path {
			return
		}
	}
	for i := range d.index.WorkFiles {
		if d.index.WorkFiles[i].Path == w.Path {
			d.index.WorkFiles[i].At = w.At
			return
		}
	}
	d.index.WorkFiles = append(d.index.WorkFiles, w)
	if len(d.index.WorkFiles) > maxWorkFiles {
		d.index.WorkFiles = append([]molten.MaterialWorkFile(nil), d.index.WorkFiles[len(d.index.WorkFiles)-maxWorkFiles:]...)
	}
	s.saveLocked(d, folder)
}

// dropWorkFileLocked forgets a work file that became a material.
func (s *Store) dropWorkFileLocked(d *drawer, path string) bool {
	for i := range d.index.WorkFiles {
		if d.index.WorkFiles[i].Path == path {
			d.index.WorkFiles = append(d.index.WorkFiles[:i:i], d.index.WorkFiles[i+1:]...)
			return true
		}
	}
	return false
}

// Add declares a material from `molten material add` (signal 5) or keeps one for the developer: a copy for a file, a
// link for an address.
func (r *Registry) Add(blockId string, workspaceId string, target string, cwd string, title string, requested bool, source string) (molten.Material, error) {
	var c Capture
	if blockId != "" {
		bc := r.context(blockId)
		if bc == nil {
			return molten.Material{}, errors.New("no such terminal")
		}
		run := ""
		if r.runOf != nil {
			if info, ok := r.runOf(blockId); ok {
				run = info.Agent
			}
		}
		c = r.who(blockId, run, bc)
		if bc.info.Remote && !strings.HasPrefix(target, "https://") && !strings.HasPrefix(target, "http://") {
			return molten.Material{}, errors.New("a remote terminal can declare addresses only, not files of the remote machine")
		}
	} else {
		info, err := r.workspaceInfo(workspaceId)
		if err != nil {
			return molten.Material{}, err
		}
		c.Project, c.Folder = ProjectKey(info.Project)
		c.WorkspaceId = workspaceId
	}
	c.Source, c.ToolTitle, c.Requested = source, title, requested
	target = strings.TrimSpace(target)
	switch {
	case strings.HasPrefix(target, "https://") || strings.HasPrefix(target, "http://"):
		c.Link = target
	case target == "":
		return molten.Material{}, errors.New("give a file or an address")
	default:
		if strings.HasPrefix(target, "~/") && r.home != "" {
			target = filepath.Join(r.home, target[2:])
		}
		if !filepath.IsAbs(target) {
			if cwd == "" || !filepath.IsAbs(cwd) {
				return molten.Material{}, errors.New("give an absolute path")
			}
			target = filepath.Join(cwd, target)
		}
		c.Path = target
	}
	m, _, err := r.capture(c)
	if err != nil {
		return molten.Material{}, err
	}
	if m.Id == "" {
		return molten.Material{}, errors.New("not kept")
	}
	if blockId != "" {
		r.lock.Lock()
		if bc := r.blocks[blockId]; bc != nil && m.MayBeLost && len(bc.turn) < maxTurnMaterials {
			bc.turn[m.Id] = true
		}
		r.lock.Unlock()
	}
	return m, nil
}

// workspaceInfo is the project of a workspace a window names.
func (r *Registry) workspaceInfo(workspaceId string) (BlockInfo, error) {
	if r.workspaceOf == nil {
		return BlockInfo{}, errors.New("no workspace lookup")
	}
	return r.workspaceOf(workspaceId)
}

// Copy makes a copy of a material kept as a reference: "Keep a copy" (the requested limit) and "Keep anyway" on one
// the secret detection held back (FR-MAT-002).
func (r *Registry) Copy(key string, id string, requested bool, allowSecret bool) (molten.Material, error) {
	m, err := r.store.Get(key, id)
	if err != nil {
		return molten.Material{}, err
	}
	if m.Original == "" {
		return molten.Material{}, errors.New("this material has no file to copy")
	}
	c := Capture{Project: m.Project, Source: m.Source, Path: m.Original, Link: m.Link, ArtifactId: m.ArtifactId, Requested: requested, AllowSecret: allowSecret, Tool: m.Tool, Agent: m.Agent, SessionId: m.SessionId, Subject: m.Subject, Ticket: m.Ticket}
	out, _, err := r.capture(c)
	return out, err
}
