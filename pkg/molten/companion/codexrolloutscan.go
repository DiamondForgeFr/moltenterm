// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package companion

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// What a Codex rollout says of its latest turn (#1967): the model and effort of its settings, the folder of its turn,
// whether the turn ended, and the folders its latest commands ran in. A sub-agent works a long time in one turn, and
// codex-cli writes a turn's turn_context once, when the turn starts; a forked sub-agent's rollout also begins with a
// copy of its parent's history. What names its model and folder therefore lies a megabyte or more from the end of
// the file after a minute of work, out of any tail of fixed size. The records are read from the start of the file,
// once, then only by the bytes appended since.

const (
	// A read takes at most this much: a rollout that grew past it between two reads is read from its end.
	codexScanMaxBytes = 64 * 1024 * 1024
	codexScanBuffer   = 256 * 1024
)

var codexCommandExecutionMarker = []byte(`"CommandExecution"`)

// codexTurnState is what the records read so far say; the zero value is a rollout with no record.
type codexTurnState struct {
	settings molten.AgentSettings
	cwd      string
	ended    bool
	// folders: where the latest commands ran, each once, the newest first.
	folders []string
}

// feed takes the next record of the rollout. threadId is the rollout's own thread: a settings change of another one
// (a copied parent's) is left out.
func (s *codexTurnState) feed(line []byte, threadId string) {
	if settings, ok := codexSettingsLine(line, threadId); ok {
		s.settings = settings
	}
	if cwd := codexTurnContextCwd(line); cwd != "" {
		s.cwd = cwd
	}
	if ended, ok := codexTurnEnd(line); ok {
		s.ended = ended
	}
	if codexCommandRecord(line) {
		if folder := strings.TrimSpace(codexCommandFolder(line)); folder != "" {
			s.noteFolder(folder)
		}
	}
}

func (s *codexTurnState) noteFolder(folder string) {
	rest := make([]string, 0, codexMaxCommandFolders)
	rest = append(rest, folder)
	for _, f := range s.folders {
		if f != folder && len(rest) < codexMaxCommandFolders {
			rest = append(rest, f)
		}
	}
	s.folders = rest
}

func codexTurnContextCwd(line []byte) string {
	if !bytes.Contains(line, codexTurnContextMarker) {
		return ""
	}
	var rec struct {
		Type    string `json:"type"`
		Payload struct {
			Cwd string `json:"cwd"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "turn_context" {
		return ""
	}
	return rec.Payload.Cwd
}

// codexTurnEnd reads a turn's start (false) or end (true) from a record.
func codexTurnEnd(line []byte) (ended bool, ok bool) {
	done := bytes.Contains(line, codexTaskCompleteMarker) || bytes.Contains(line, codexTurnAbortedMarker) || bytes.Contains(line, codexTurnCompleteMarker)
	started := bytes.Contains(line, codexTaskStartedMarker) || bytes.Contains(line, codexTurnStartedMarker)
	if !done && !started {
		return false, false
	}
	var rec struct {
		Type    string `json:"type"`
		Payload struct {
			Type string `json:"type"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "event_msg" {
		return false, false
	}
	switch rec.Payload.Type {
	case "task_complete", "turn_complete", "turn_aborted":
		return true, true
	case "task_started", "turn_started":
		return false, true
	}
	return false, false
}

// codexLastTurn reads, from a rollout's last lines, its latest turn's folder, whether that turn ended, and the folders
// its latest shell commands ran in (newest first, each once, at most codexMaxCommandFolders).
func codexLastTurn(tail []byte) (cwd string, ended bool, folders []string) {
	var state codexTurnState
	for len(tail) > 0 {
		line := tail
		if i := bytes.IndexByte(tail, '\n'); i >= 0 {
			line, tail = tail[:i], tail[i+1:]
		} else {
			tail = nil
		}
		state.feed(line, "")
	}
	return state.cwd, state.ended, state.folders
}

type codexScan struct {
	threadId string
	offset   int64
	state    codexTurnState
}

// scanRollout reads what the rollout at path says of its latest turn, from where the previous read of it stopped.
// threadId is the thread the rollout belongs to.
func (a *CodexAdapter) scanRollout(path string, threadId string) (codexTurnState, bool) {
	a.scanLock.Lock()
	defer a.scanLock.Unlock()
	f, err := os.Open(path)
	if err != nil {
		return codexTurnState{}, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return codexTurnState{}, false
	}
	scan := a.scans[path]
	if scan == nil || scan.threadId != threadId || info.Size() < scan.offset {
		scan = &codexScan{threadId: threadId}
	}
	start := scan.offset
	resync := false
	if info.Size()-start > codexScanMaxBytes {
		start, resync = info.Size()-codexScanMaxBytes, true
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return codexTurnState{}, false
	}
	reader := bufio.NewReaderSize(io.LimitReader(f, info.Size()-start), codexScanBuffer)
	offset := start
	if resync {
		skipped, _ := reader.ReadBytes('\n')
		offset += int64(len(skipped))
	}
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			scan.state.feed(line, threadId)
			offset += int64(len(line))
		}
		if err != nil {
			break
		}
	}
	scan.offset = offset
	if a.scans == nil || len(a.scans) >= codexMaxHeadCache {
		a.scans = map[string]*codexScan{}
	}
	a.scans[path] = scan
	state := scan.state
	state.folders = append([]string(nil), state.folders...)
	return state, true
}
