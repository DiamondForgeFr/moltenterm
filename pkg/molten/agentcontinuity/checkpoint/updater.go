// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
)

// The automatic updates (DS-CONT-009). Triggers: an agent's end of turn reported by its hook (Claude Code's Stop hook
// added by #318, Codex's notify of #320), a turn end or new activity read in the pane's transcript while the agent is
// not working (Codex until #320, agents started without MoltenTerm's hooks), and a new session linked to the pane. A
// workspace is updated at the earliest TriggerDelay after a trigger, then at most once per WorkspaceInterval. The
// sources are only read: the transcript through the companion's reader, git through read-only commands that take no
// lock, so the repository's state and `git status` do not change.

const (
	TriggerDelay      = time.Second
	WorkspaceInterval = 10 * time.Second
	PollInterval      = 5 * time.Second
	// A pane whose agent is gone is forgotten after this long (its last turn was written by then).
	BlockForget = 2 * time.Minute
	gitTimeout  = 2 * time.Second
	// The transcript of a pane whose agent is not hooked is looked for at most this often, once linked.
	relinkInterval    = 15 * time.Second
	unlinkedFastTries = 12
	unlinkedInterval  = 30 * time.Second
)

// sessionReader is what the updater needs of companion.SessionReader.
type sessionReader interface {
	Poll() (companion.SessionDigest, error)
	Close()
}

type blockFolder struct {
	cwd    string
	remote bool
}

type blockState struct {
	lock sync.Mutex
	// Guarded by lock.
	agent     string
	path      string
	reader    sessionReader
	signature string
	turns     int
	// forgotten: the pane closed; no reader is opened for it again (guarded by lock).
	forgotten bool
	// Guarded by the updater's lock.
	wsId     string
	seen     time.Time
	linkedAt time.Time
	misses   int
}

type wsState struct {
	last time.Time
	// pending: the panes to read, with when each was triggered (applied in that order: the latest wins).
	pending map[string]time.Time
	timer   func() bool
}

// Updater keeps the checkpoints of the workspaces up to date.
type Updater struct {
	store *Store
	lock  sync.Mutex
	// Guarded by lock.
	blocks     map[string]*blockState
	workspaces map[string]*wsState

	// Injected: the agent states, the companion, the object store, git and the clock; replaced in tests.
	runs        func() []molten.AgentRunInfo
	linked      func(blockId string) (string, string, bool)
	workspaceOf func(blockId string) (string, error)
	folderOf    func(blockId string) (blockFolder, error)
	openReader  func(agent string, path string) (sessionReader, error)
	gitState    func(folder string) GitState
	home        string
	now         func() time.Time
	afterFunc   func(d time.Duration, fn func()) func() bool
	delay       time.Duration
	interval    time.Duration
}

func MakeUpdater(store *Store) *Updater {
	home, _ := os.UserHomeDir()
	return &Updater{
		store:      store,
		blocks:     map[string]*blockState{},
		workspaces: map[string]*wsState{},
		openReader: func(agent string, path string) (sessionReader, error) {
			return companion.OpenSessionReader(agent, path)
		},
		gitState: ReadGitState,
		home:     home,
		now:      time.Now,
		afterFunc: func(d time.Duration, fn func()) func() bool {
			return time.AfterFunc(d, fn).Stop
		},
		delay:    TriggerDelay,
		interval: WorkspaceInterval,
	}
}

func (u *Updater) block(blockId string) *blockState {
	u.lock.Lock()
	defer u.lock.Unlock()
	bs := u.blocks[blockId]
	if bs == nil {
		bs = &blockState{}
		u.blocks[blockId] = bs
	}
	bs.seen = u.now()
	return bs
}

// TurnEnded is the agent states' listener: a hook reported the end of a turn.
func (u *Updater) TurnEnded(blockId string, agent string) {
	u.Trigger(blockId)
}

// Trigger schedules the update of the block's workspace.
func (u *Updater) Trigger(blockId string) {
	wsId, err := u.blockWorkspace(blockId)
	if err != nil || wsId == "" {
		return
	}
	u.lock.Lock()
	defer u.lock.Unlock()
	ws := u.workspaces[wsId]
	if ws == nil {
		ws = &wsState{pending: map[string]time.Time{}}
		u.workspaces[wsId] = ws
	}
	ws.pending[blockId] = u.now()
	if ws.timer != nil {
		return
	}
	wait := u.delay
	if !ws.last.IsZero() {
		if until := ws.last.Add(u.interval).Sub(u.now()); until > wait {
			wait = until
		}
	}
	ws.timer = u.afterFunc(wait, func() {
		defer func() {
			panichandler.PanicHandler("molten:checkpoint:update", recover())
		}()
		u.flush(wsId)
	})
}

// blockWorkspace finds the block's workspace once per block (a pane does not change workspace while its agent runs).
func (u *Updater) blockWorkspace(blockId string) (string, error) {
	bs := u.block(blockId)
	u.lock.Lock()
	wsId := bs.wsId
	u.lock.Unlock()
	if wsId != "" {
		return wsId, nil
	}
	if u.workspaceOf == nil {
		return "", fmt.Errorf("no workspace lookup")
	}
	wsId, err := u.workspaceOf(blockId)
	if err != nil {
		return "", err
	}
	u.lock.Lock()
	defer u.lock.Unlock()
	bs.wsId = wsId
	return wsId, nil
}

func (u *Updater) takePending(wsId string) []string {
	u.lock.Lock()
	defer u.lock.Unlock()
	ws := u.workspaces[wsId]
	if ws == nil {
		return nil
	}
	ws.timer = nil
	ws.last = u.now()
	rtn := make([]string, 0, len(ws.pending))
	for blockId := range ws.pending {
		rtn = append(rtn, blockId)
	}
	pending := ws.pending
	sort.Slice(rtn, func(i, j int) bool {
		if !pending[rtn[i]].Equal(pending[rtn[j]]) {
			return pending[rtn[i]].Before(pending[rtn[j]])
		}
		return rtn[i] < rtn[j]
	})
	ws.pending = map[string]time.Time{}
	return rtn
}

// flush writes one update of a workspace from every pane that triggered it.
func (u *Updater) flush(wsId string) {
	var inputs []AutoInput
	// Panes of the same folder read its branch once per update.
	gitStates := map[string]GitState{}
	for _, blockId := range u.takePending(wsId) {
		if in, ok := u.inputOf(blockId, gitStates); ok {
			inputs = append(inputs, in)
		}
	}
	if len(inputs) == 0 {
		return
	}
	_, err := u.store.Update(wsId, OwnerAuto, func(c *Checkpoint) bool {
		changed := false
		for _, in := range inputs {
			changed = ApplyAuto(c, in) || changed
		}
		return changed
	})
	if err != nil {
		log.Printf("molten: task checkpoint of workspace %s not updated: %v\n", wsId, err)
	}
}

// inputOf reads what a pane's session says now.
func (u *Updater) inputOf(blockId string, gitStates map[string]GitState) (AutoInput, bool) {
	bs := u.block(blockId)
	if agent, path, ok := u.linkedSession(blockId); ok {
		u.setSession(bs, agent, path)
	}
	digest, agent, path, ok := u.pollBlock(bs)
	if !ok {
		return AutoInput{}, false
	}
	in := AutoInput{Agent: agent, SessionId: digest.Id, TranscriptPath: path, Digest: digest, Home: u.home, At: u.now().UnixMilli()}
	folder := digest.Cwd
	if u.folderOf != nil {
		if bf, err := u.folderOf(blockId); err == nil {
			if bf.remote {
				return AutoInput{}, false
			}
			if bf.cwd != "" {
				folder = bf.cwd
			}
		}
	}
	in.Folder = folder
	if folder != "" && u.gitState != nil {
		g, ok := gitStates[folder]
		if !ok {
			g = u.gitState(folder)
			gitStates[folder] = g
		}
		in.Git = g
	}
	return in, true
}

func (u *Updater) linkedSession(blockId string) (string, string, bool) {
	if u.linked == nil {
		return "", "", false
	}
	return u.linked(blockId)
}

// setSession follows a pane's session, a new reader when the session changed; it tells whether it changed.
func (u *Updater) setSession(bs *blockState, agent string, path string) bool {
	bs.lock.Lock()
	defer bs.lock.Unlock()
	if bs.forgotten || (bs.path == path && bs.agent == agent && bs.reader != nil) {
		return false
	}
	if bs.reader != nil {
		bs.reader.Close()
		bs.reader = nil
	}
	bs.agent, bs.path, bs.signature, bs.turns = agent, path, "", 0
	r, err := u.openReader(agent, path)
	if err != nil {
		bs.path = ""
		return false
	}
	bs.reader = r
	return true
}

func (u *Updater) pollBlock(bs *blockState) (companion.SessionDigest, string, string, bool) {
	bs.lock.Lock()
	defer bs.lock.Unlock()
	if bs.reader == nil {
		return companion.SessionDigest{}, "", "", false
	}
	d, err := bs.reader.Poll()
	if err != nil {
		bs.reader.Close()
		bs.reader, bs.path = nil, ""
		return companion.SessionDigest{}, "", "", false
	}
	return d, bs.agent, bs.path, true
}

// activity tells, from a fresh poll, whether the session has news a checkpoint shows: a turn ended, or prompts, files
// or the task list changed.
func (u *Updater) activity(bs *blockState) (bool, bool) {
	bs.lock.Lock()
	defer bs.lock.Unlock()
	if bs.reader == nil {
		return false, false
	}
	d, err := bs.reader.Poll()
	if err != nil {
		bs.reader.Close()
		bs.reader, bs.path = nil, ""
		return false, false
	}
	turnEnded := d.TurnsEnded > bs.turns
	bs.turns = d.TurnsEnded
	sig := digestSignature(d)
	changed := sig != bs.signature
	bs.signature = sig
	return turnEnded, changed
}

func digestSignature(d companion.SessionDigest) string {
	var b strings.Builder
	b.WriteString(strconv.Itoa(len(d.Prompts)))
	if len(d.Prompts) > 0 {
		b.WriteString("/" + strconv.FormatInt(d.Prompts[len(d.Prompts)-1].At, 10))
	}
	b.WriteString("/" + strconv.Itoa(len(d.Files)))
	if len(d.Files) > 0 {
		b.WriteString("/" + strconv.FormatInt(d.Files[0].At, 10) + "/" + d.Files[0].Path)
	}
	b.WriteString("/" + strconv.FormatInt(d.TodosAt, 10) + "/" + strconv.Itoa(len(d.Todos)))
	for _, t := range d.Todos {
		b.WriteString("/" + t.Status)
	}
	return b.String()
}

// Tick looks at every running agent once: a new session linked to its pane, or news in its transcript while it is not
// working, triggers an update.
func (u *Updater) Tick() {
	if u.runs == nil {
		return
	}
	now := u.now()
	running := map[string]bool{}
	for _, run := range u.runs() {
		if !run.Running {
			continue
		}
		running[run.BlockId] = true
		bs := u.block(run.BlockId)
		if u.shouldRelink(bs, now) {
			if agent, path, ok := u.linkedSession(run.BlockId); ok && u.setSession(bs, agent, path) {
				u.markLinked(bs, now)
				u.activity(bs)
				u.Trigger(run.BlockId)
				continue
			}
			u.markLinked(bs, now)
		}
		turnEnded, changed := u.activity(bs)
		if turnEnded || (changed && run.State != molten.AgentStateWorking) {
			u.Trigger(run.BlockId)
		}
	}
	u.forgetGone(running, now)
}

// shouldRelink: a linked pane is looked at every relinkInterval (a /clear starts a new session); an unlinked one on
// every tick for its first unlinkedFastTries, then every unlinkedInterval (discovery reads the agent's session folder).
func (u *Updater) shouldRelink(bs *blockState, now time.Time) bool {
	bs.lock.Lock()
	linked := bs.reader != nil
	bs.lock.Unlock()
	u.lock.Lock()
	defer u.lock.Unlock()
	if linked {
		return now.Sub(bs.linkedAt) >= relinkInterval
	}
	return bs.misses < unlinkedFastTries || now.Sub(bs.linkedAt) >= unlinkedInterval
}

func (u *Updater) markLinked(bs *blockState, now time.Time) {
	u.lock.Lock()
	defer u.lock.Unlock()
	bs.linkedAt = now
	bs.lock.Lock()
	linked := bs.reader != nil
	bs.lock.Unlock()
	if linked {
		bs.misses = 0
		return
	}
	bs.misses++
}

func (u *Updater) forgetGone(running map[string]bool, now time.Time) {
	var gone []*blockState
	u.lock.Lock()
	for blockId, bs := range u.blocks {
		if running[blockId] || now.Sub(bs.seen) < BlockForget {
			continue
		}
		if u.blockPendingLocked(blockId) {
			continue
		}
		gone = append(gone, bs)
		delete(u.blocks, blockId)
	}
	for wsId, ws := range u.workspaces {
		if ws.timer == nil && len(ws.pending) == 0 && now.Sub(ws.last) > u.interval {
			delete(u.workspaces, wsId)
		}
	}
	u.lock.Unlock()
	for _, bs := range gone {
		closeBlock(bs)
	}
}

func (u *Updater) blockPendingLocked(blockId string) bool {
	for _, ws := range u.workspaces {
		if _, ok := ws.pending[blockId]; ok {
			return true
		}
	}
	return false
}

func closeBlock(bs *blockState) {
	bs.lock.Lock()
	defer bs.lock.Unlock()
	bs.forgotten = true
	if bs.reader != nil {
		bs.reader.Close()
		bs.reader = nil
	}
}

// ForgetBlock drops a closed pane's reader.
func (u *Updater) ForgetBlock(blockId string) {
	u.lock.Lock()
	bs := u.blocks[blockId]
	delete(u.blocks, blockId)
	u.lock.Unlock()
	if bs != nil {
		closeBlock(bs)
	}
}

// Run polls until stop is closed.
func (u *Updater) Run(stop <-chan struct{}) {
	defer func() {
		panichandler.PanicHandler("molten:checkpoint:poll", recover())
	}()
	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			u.Tick()
		}
	}
}

// ReadGitState reads a folder's branch and its distance to its upstream with read-only git commands that take no
// lock (--no-optional-locks): the repository is not changed.
func ReadGitState(folder string) GitState {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	inside, err := runGit(ctx, folder, "rev-parse", "--is-inside-work-tree")
	if err != nil || inside != "true" {
		return GitState{}
	}
	g := GitState{Repo: true}
	if branch, err := runGit(ctx, folder, "symbolic-ref", "--short", "-q", "HEAD"); err == nil {
		g.Branch = branch
	} else if head, err := runGit(ctx, folder, "rev-parse", "--short", "HEAD"); err == nil {
		g.Detached = head
	}
	if g.Branch == "" {
		return g
	}
	counts, err := runGit(ctx, folder, "rev-list", "--left-right", "--count", "@{upstream}...HEAD")
	if err != nil {
		return g
	}
	fields := strings.Fields(counts)
	if len(fields) == 2 {
		behind, errB := strconv.Atoi(fields[0])
		ahead, errA := strconv.Atoi(fields[1])
		if errA == nil && errB == nil {
			g.HasUpstream, g.Ahead, g.Behind = true, ahead, behind
		}
	}
	return g
}

func runGit(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
