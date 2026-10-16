// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package companion

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Codex writes its model and reasoning effort nowhere but in the rollout: each turn starts with a turn_context record
// whose payload holds the turn's model and effort (codex-cli 0.162.0, protocol.rs TurnContextItem), and a change made
// with /model writes a thread_settings_applied event ({thread_id, thread_settings: {model, reasoning_effort}}) as it
// applies; its hooks and notify carry no effort (#549). The settings shown are the latest of the two.

const (
	// The end of a rollout read for its latest settings. A turn whose records outgrow it leaves the settings as
	// they were.
	codexSettingsTail = 2 * 1024 * 1024
	codexSettingMax   = 80
)

var (
	codexTurnContextMarker    = []byte(`"turn_context"`)
	codexThreadSettingsMarker = []byte(`"thread_settings_applied"`)
)

// ReadSettings reads the model and effort the rollout's latest records give.
func (a *CodexAdapter) ReadSettings(path string) (molten.AgentSettings, bool) {
	tail, err := readFileTail(path, codexSettingsTail)
	if err != nil {
		return molten.AgentSettings{}, false
	}
	return codexLastTurnSettings(tail, SessionIdFromPath(molten.AgentIdCodex, path))
}

// ReadSettingsFrom reads the settings the rollout's complete lines from offset on give (the last 2 MB at most), for
// a follower that reads only what was appended since its previous look. next is where the next look starts: after
// the last complete line, or 0 when the file shrank (another file at that path).
func (a *CodexAdapter) ReadSettingsFrom(path string, offset int64) (settings molten.AgentSettings, found bool, next int64) {
	f, err := os.Open(path)
	if err != nil {
		return molten.AgentSettings{}, false, offset
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return molten.AgentSettings{}, false, offset
	}
	size := info.Size()
	if size < offset {
		return molten.AgentSettings{}, false, 0
	}
	start := offset
	if size-start > codexSettingsTail {
		start = size - codexSettingsTail
	}
	if start == size {
		return molten.AgentSettings{}, false, offset
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return molten.AgentSettings{}, false, offset
	}
	data, err := io.ReadAll(io.LimitReader(f, size-start))
	if err != nil {
		return molten.AgentSettings{}, false, offset
	}
	end := bytes.LastIndexByte(data, '\n') + 1
	if end == 0 {
		// No complete line yet: a record being written. A line longer than the whole read is skipped.
		if int64(len(data)) >= codexSettingsTail {
			return molten.AgentSettings{}, false, size
		}
		return molten.AgentSettings{}, false, offset
	}
	settings, found = codexLastTurnSettings(data[:end], SessionIdFromPath(molten.AgentIdCodex, path))
	return settings, found, start + int64(end)
}

// codexLastTurnSettings reads the latest settings record of a rollout's lines: the last turn_context, or a later
// thread_settings_applied of the rollout's own thread (threadId, when known).
func codexLastTurnSettings(tail []byte, threadId string) (molten.AgentSettings, bool) {
	for end := len(tail); end > 0; {
		start := bytes.LastIndexByte(tail[:end], '\n') + 1
		line := tail[start:end]
		end = start - 1
		if settings, ok := codexSettingsLine(line, threadId); ok {
			return settings, true
		}
	}
	return molten.AgentSettings{}, false
}

func codexSettingsLine(line []byte, threadId string) (molten.AgentSettings, bool) {
	if bytes.Contains(line, codexTurnContextMarker) {
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Model  any `json:"model"`
				Effort any `json:"effort"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &rec) == nil && rec.Type == "turn_context" {
			settings := molten.AgentSettings{Model: codexSettingText(rec.Payload.Model), Effort: codexSettingText(rec.Payload.Effort)}
			return settings, settings.Model != "" || settings.Effort != ""
		}
	}
	if !bytes.Contains(line, codexThreadSettingsMarker) {
		return molten.AgentSettings{}, false
	}
	var rec struct {
		Type    string         `json:"type"`
		Payload map[string]any `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "event_msg" {
		return molten.AgentSettings{}, false
	}
	return codexThreadSettings(rec.Payload, threadId)
}

// codexThreadSettings reads a thread_settings_applied event; one of another thread (a sub-agent's) is left out.
func codexThreadSettings(ev map[string]any, threadId string) (molten.AgentSettings, bool) {
	if str(ev, "type") != "thread_settings_applied" {
		return molten.AgentSettings{}, false
	}
	if id := str(ev, "thread_id"); id != "" && threadId != "" && !strings.EqualFold(id, threadId) {
		return molten.AgentSettings{}, false
	}
	ts := obj(ev, "thread_settings")
	settings := molten.AgentSettings{Model: codexSettingText(ts["model"]), Effort: codexSettingText(ts["reasoning_effort"])}
	return settings, settings.Model != "" || settings.Effort != ""
}

func codexSettingText(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	s = strings.TrimSpace(s)
	if s == "" || len(s) > codexSettingMax {
		return ""
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return ""
		}
	}
	return s
}

// readFileTail reads at most max bytes from the end of a regular file.
func readFileTail(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, os.ErrInvalid
	}
	offset := info.Size() - max
	if offset < 0 {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	return io.ReadAll(io.LimitReader(f, max))
}
