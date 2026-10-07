// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The workspace task checkpoint (FR-CONT-007, pkg/molten/agentcontinuity/checkpoint) reads the session of a pane
// whether or not its companion is open: a SessionReader follows the transcript the same way, read-only, without the
// diffs, and LinkedSession tells which transcript is the pane's without claiming it.

// At most this many chunks (tailChunkMax each) are read per Poll: a burst is caught up over the next polls.
const readerMaxChunks = 32

// SessionReader follows one transcript for its digest.
type SessionReader struct {
	Agent    string
	Path     string
	adapter  Adapter
	follower *follower
	session  *Session
}

// OpenSessionReader checks the path is a session of the agent (under its session folder, in its layout) and opens it.
func OpenSessionReader(agent string, path string) (*SessionReader, error) {
	adapter := AdapterFor(agent)
	if adapter == nil {
		return nil, fmt.Errorf("no transcript reader for %s", molten.AgentDisplayName(agent))
	}
	return OpenAdapterSessionReader(adapter, path)
}

// OpenAdapterSessionReader is OpenSessionReader with a given adapter (its roots: tests use their own).
func OpenAdapterSessionReader(adapter Adapter, path string) (*SessionReader, error) {
	resolved, err := ValidateSessionPath(adapter, path)
	if err != nil {
		return nil, err
	}
	f, err := openFollower(resolved)
	if err != nil {
		return nil, err
	}
	return &SessionReader{Agent: adapter.Id(), Path: resolved, adapter: adapter, follower: f, session: MakeLeanSession()}, nil
}

// Poll reads what was appended since the last call and returns the session's digest.
func (r *SessionReader) Poll() (SessionDigest, error) {
	if r.follower == nil {
		return SessionDigest{}, fmt.Errorf("the session reader is closed")
	}
	for i := 0; i < readerMaxChunks; i++ {
		reset, more, err := r.follower.poll(func(line []byte) {
			parseRecordLine(r.adapter, r.session, line)
		})
		if err != nil {
			return SessionDigest{}, err
		}
		if reset {
			r.session = MakeLeanSession()
			continue
		}
		if !more {
			break
		}
	}
	d := r.session.Digest()
	if d.Id == "" && r.adapter.Id() == molten.AgentIdClaude {
		// Claude Code names the transcript after its session.
		d.Id = strings.TrimSuffix(filepath.Base(r.Path), ".jsonl")
	}
	return d, nil
}

func (r *SessionReader) Close() {
	if r.follower != nil {
		r.follower.close()
		r.follower = nil
	}
}

// LinkedSession tells which transcript belongs to the agent running in a block: the one its companion follows, else
// its hook's report, the user's pick, or the only session discovery can link without asking. Nothing is claimed.
func (m *Manager) LinkedSession(blockId string) (string, string, bool) {
	if m.runOf == nil {
		return "", "", false
	}
	run, ok := m.runOf(blockId)
	if !ok {
		return "", "", false
	}
	if w := m.watcher(blockId); w != nil {
		if agent, path := w.linkedPath(); path != "" && agent == run.Agent {
			return agent, path, true
		}
	}
	if report, ok := m.report(blockId); ok && report.agent == run.Agent && !report.at.Before(time.UnixMilli(run.Started).Add(-reportSlack)) {
		return report.agent, report.path, true
	}
	if pick, ok := m.pick(blockId); ok && pick.agent == run.Agent && pick.started == run.Started {
		return pick.agent, pick.path, true
	}
	return m.discoverLinked(blockId, run)
}

func (m *Manager) discoverLinked(blockId string, run molten.AgentRunInfo) (string, string, bool) {
	adapter := m.adapterFor(run.Agent)
	if adapter == nil || m.blockInfo == nil {
		return "", "", false
	}
	info, err := m.blockInfo(blockId)
	if err != nil || info.remote || info.cwd == "" {
		return "", "", false
	}
	var free []Candidate
	written := 0
	for _, c := range adapter.Discover(info.cwd, time.UnixMilli(run.Started)) {
		c.Path = canonicalPath(c.Path)
		if c.Modified >= run.Started {
			written++
		}
		if !m.takenByOther(blockId, c.Path) {
			free = append(free, c)
		}
	}
	if m.now().Sub(time.UnixMilli(run.Started)) < resumeGrace {
		written = 0
	}
	chosen, ambiguous := chooseCandidate(free, written, run.Started, m.sameFolderRuns(run.Agent, info.cwd))
	if chosen == nil || ambiguous {
		return "", "", false
	}
	resolved, err := ValidateSessionPath(adapter, chosen.Path)
	if err != nil {
		return "", "", false
	}
	return run.Agent, resolved, true
}

func (w *watcher) linkedPath() (string, string) {
	w.lock.Lock()
	defer w.lock.Unlock()
	return w.agent, w.path
}

// LinkedSession is the companion's answer for wavesrv's manager; false before Start.
func LinkedSession(blockId string) (string, string, bool) {
	m := defaultManager
	if m == nil {
		return "", "", false
	}
	return m.LinkedSession(blockId)
}
