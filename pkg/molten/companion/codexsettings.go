// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

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
	// codexModelNotFound: Codex's codex_error_info when the account cannot use the turn's model (#2076).
	codexModelNotFound = "model_not_found"
)

var (
	codexTurnContextMarker    = []byte(`"turn_context"`)
	codexThreadSettingsMarker = []byte(`"thread_settings_applied"`)
	codexModelNotFoundMarker  = []byte(`"` + codexModelNotFound + `"`)
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
// thread_settings_applied of the rollout's own thread (threadId, when known). A turn end after it that Codex refused
// for the model (model_not_found, #2076) marks the model unavailable; lines that hold only that refusal give the
// mark alone, without a model (mergeFollowedSettings keeps the model already known).
func codexLastTurnSettings(tail []byte, threadId string) (molten.AgentSettings, bool) {
	refused := false
	for end := len(tail); end > 0; {
		start := bytes.LastIndexByte(tail[:end], '\n') + 1
		line := tail[start:end]
		end = start - 1
		if settings, ok := codexSettingsLine(line, threadId); ok {
			settings.ModelUnavailable = refused
			return settings, true
		}
		if !refused && codexModelRefusedLine(line) {
			refused = true
		}
	}
	if refused {
		return molten.AgentSettings{ModelUnavailable: true}, true
	}
	return molten.AgentSettings{}, false
}

// codexModelRefusedLine tells whether a line is a turn end Codex refused because the model is not available to the
// account: {"type":"event_msg","payload":{"type":"task_complete","error":{"codex_error_info":"model_not_found"}}}
// (codex-cli 0.166.0, "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.").
func codexModelRefusedLine(line []byte) bool {
	if !bytes.Contains(line, codexModelNotFoundMarker) {
		return false
	}
	var rec struct {
		Type    string `json:"type"`
		Payload struct {
			Type  string `json:"type"`
			Error struct {
				Info any `json:"codex_error_info"`
			} `json:"error"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &rec) != nil || rec.Type != "event_msg" {
		return false
	}
	switch rec.Payload.Type {
	case "task_complete", "turn_complete", "turn_aborted":
	default:
		return false
	}
	info, _ := rec.Payload.Error.Info.(string)
	return info == codexModelNotFound
}

// mergeFollowedSettings applies what a follower read since its previous look to the settings it knew: a refusal alone
// keeps the known model and effort.
func mergeFollowedSettings(known molten.AgentSettings, read molten.AgentSettings) molten.AgentSettings {
	if read.Model == "" && read.Effort == "" && read.ModelUnavailable {
		known.ModelUnavailable = true
		return known
	}
	return read
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
	f, err := openTranscript(path)
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
