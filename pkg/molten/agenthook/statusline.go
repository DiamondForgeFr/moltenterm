// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

// What the status line relay reads of Claude Code's status line input (FR-SHELL-027, DS-SHELL-031): the documented
// rate_limits object (https://code.claude.com/docs/en/statusline), and nothing else. pkg/molten names these types.

// The relay reads at most this much of the status line input; the chained command still gets all of it.
const StatusLineMaxInput = 256 * 1024

// StatusLineWindow is one rate limit window as Claude Code gives it: percent used (0 to 100, or more behind a
// spend limit) and its reset in Unix seconds, 0 when absent.
type StatusLineWindow struct {
	UsedPercent float64 `json:"usedpercent"`
	ResetsAt    int64   `json:"resetsat,omitempty"`
}

// AgentStatusLineRequest is what the relay sends: the rate limit windows of one status line run, nothing else.
type AgentStatusLineRequest struct {
	BlockId string `json:"blockid"`
	// RateLimits: the input had a rate_limits object (a Pro or Max plan, or a gateway spend limit), readable or not.
	RateLimits bool              `json:"ratelimits,omitempty"`
	FiveHour   *StatusLineWindow `json:"fivehour,omitempty"`
	SevenDay   *StatusLineWindow `json:"sevenday,omitempty"`
	SpendLimit *StatusLineWindow `json:"spendlimit,omitempty"`
}

// AgentStatusLineResponse is wavesrv's answer to the relay. Kept: the windows are kept, the user shows Claude Code's
// plan usage; while not, the relay hands them over again sooner (FR-PERF-012).
type AgentStatusLineResponse struct {
	Kept bool `json:"kept"`
}

// HasWindows tells whether any window was read.
func (r AgentStatusLineRequest) HasWindows() bool {
	return r.FiveHour != nil || r.SevenDay != nil || r.SpendLimit != nil
}

type statusLineRawWindow struct {
	UsedPercentage *float64 `json:"used_percentage"`
	ResetsAt       *float64 `json:"resets_at"`
}

// ParseStatusLineInput keeps the rate limit windows of Claude Code's status line input. An input that is not a JSON
// object is an unknown format; a window whose fields are missing or mistyped is left out.
func ParseStatusLineInput(data []byte) (AgentStatusLineRequest, error) {
	var rtn AgentStatusLineRequest
	var top map[string]json.RawMessage
	if err := json.Unmarshal(data, &top); err != nil || top == nil {
		return rtn, fmt.Errorf("the status line input is not a JSON object")
	}
	raw, ok := top["rate_limits"]
	if !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return rtn, nil
	}
	rtn.RateLimits = true
	var limits map[string]json.RawMessage
	if json.Unmarshal(raw, &limits) != nil {
		return rtn, nil
	}
	rtn.FiveHour = parseStatusLineWindow(limits["five_hour"])
	rtn.SevenDay = parseStatusLineWindow(limits["seven_day"])
	rtn.SpendLimit = parseStatusLineWindow(limits["spend_limit"])
	return rtn, nil
}

func parseStatusLineWindow(raw json.RawMessage) *StatusLineWindow {
	if len(raw) == 0 {
		return nil
	}
	var w statusLineRawWindow
	if json.Unmarshal(raw, &w) != nil || w.UsedPercentage == nil {
		return nil
	}
	pct := *w.UsedPercentage
	if math.IsNaN(pct) || math.IsInf(pct, 0) {
		return nil
	}
	rtn := &StatusLineWindow{UsedPercent: pct}
	if w.ResetsAt != nil && *w.ResetsAt > 0 && !math.IsInf(*w.ResetsAt, 0) {
		rtn.ResetsAt = int64(*w.ResetsAt)
	}
	return rtn
}
