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
// whose payload holds the turn's model and effort (codex-cli 0.162.0, protocol.rs TurnContextItem); its hooks and
// notify carry no effort (#549). The settings shown are the last turn's: a change made between turns shows from the
// next one.

const (
	// The end of a rollout read for its last turn_context. A turn whose records outgrow it leaves the settings as
	// they were.
	codexSettingsTail = 2 * 1024 * 1024
	codexSettingMax   = 80
)

var codexTurnContextMarker = []byte(`"turn_context"`)

// ReadSettings reads the model and effort of the rollout's last turn.
func (a *CodexAdapter) ReadSettings(path string) (molten.AgentSettings, bool) {
	tail, err := readFileTail(path, codexSettingsTail)
	if err != nil {
		return molten.AgentSettings{}, false
	}
	return codexLastTurnSettings(tail)
}

func codexLastTurnSettings(tail []byte) (molten.AgentSettings, bool) {
	for end := len(tail); end > 0; {
		start := bytes.LastIndexByte(tail[:end], '\n') + 1
		line := tail[start:end]
		end = start - 1
		if !bytes.Contains(line, codexTurnContextMarker) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			Payload struct {
				Model  any `json:"model"`
				Effort any `json:"effort"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.Type != "turn_context" {
			continue
		}
		settings := molten.AgentSettings{Model: codexSettingText(rec.Payload.Model), Effort: codexSettingText(rec.Payload.Effort)}
		return settings, settings.Model != "" || settings.Effort != ""
	}
	return molten.AgentSettings{}, false
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
