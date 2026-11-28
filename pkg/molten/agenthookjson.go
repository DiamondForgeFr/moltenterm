// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// The hooks adapter of Claude Code's settings.json and Codex's hooks.json (#2595): both files hold a "hooks" object of
// events, each a list of matcher groups whose "hooks" run commands. MoltenTerm's entries are the handlers running
// `molten agent hook`, `molten agent state` or `molten agent session`; applying replaces exactly those with the current
// ones and removing drops them. Every other key, event, group and handler is kept as it was, in its order; a group
// that only held MoltenTerm's handlers goes with them. The file is written back indented with two spaces.

const (
	jsonHookErrorInvalid = "invalid-json"
	jsonHookErrorShape   = "hooks-shape"

	// A duplicated MoltenTerm handler for one event: it runs twice until the update replaces both with one.
	HookFieldDuplicate = "duplicate"
)

type jsonMember struct {
	Key   string
	Value json.RawMessage
}

// jsonObject is a JSON object with its members in the file's order.
type jsonObject []jsonMember

var errJSONHookShape = errors.New("hooks are not in the expected shape")

func parseJSONObject(data []byte) (jsonObject, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, errJSONHookShape
	}
	var rtn jsonObject
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errJSONHookShape
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		rtn = append(rtn, jsonMember{Key: key, Value: raw})
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("data after the JSON object")
	}
	return rtn, nil
}

func (o jsonObject) index(key string) int {
	found := -1
	for i, member := range o {
		if member.Key == key {
			if found >= 0 {
				return -2
			}
			found = i
		}
	}
	return found
}

func marshalJSONNoEscape(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

func (o jsonObject) marshal() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, member := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := marshalJSONNoEscape(member.Key)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(member.Value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func isMoltenHookCommand(command string) bool {
	return IsAgentStateHookCommand(command) || IsAgentSessionHookCommand(command)
}

type jsonHookHandler struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout"`
}

// jsonHookConfig is a settings or hooks file read for its MoltenTerm hooks.
type jsonHookConfig struct {
	Doc       jsonObject
	Events    jsonObject
	Ours      []AgentHookEntry
	Dupes     []string
	ErrorCode string
}

func readJSONHookConfig(data []byte, exists bool) jsonHookConfig {
	var rtn jsonHookConfig
	if !exists || len(bytes.TrimSpace(data)) == 0 {
		return rtn
	}
	doc, err := parseJSONObject(data)
	if err != nil {
		rtn.ErrorCode = jsonHookErrorInvalid
		if errors.Is(err, errJSONHookShape) {
			rtn.ErrorCode = jsonHookErrorShape
		}
		return rtn
	}
	rtn.Doc = doc
	at := doc.index("hooks")
	if at == -2 {
		rtn.ErrorCode = jsonHookErrorShape
		return rtn
	}
	if at < 0 {
		return rtn
	}
	events, err := parseJSONObject(doc[at].Value)
	if err != nil {
		rtn.ErrorCode = jsonHookErrorShape
		return rtn
	}
	rtn.Events = events
	perEvent := map[string]int{}
	for _, event := range events {
		var groups []json.RawMessage
		if err := json.Unmarshal(event.Value, &groups); err != nil {
			rtn.ErrorCode = jsonHookErrorShape
			return rtn
		}
		for _, raw := range groups {
			var group struct {
				Matcher string            `json:"matcher"`
				Hooks   []json.RawMessage `json:"hooks"`
			}
			if err := json.Unmarshal(raw, &group); err != nil {
				rtn.ErrorCode = jsonHookErrorShape
				return rtn
			}
			for _, rawHandler := range group.Hooks {
				var handler jsonHookHandler
				if err := json.Unmarshal(rawHandler, &handler); err != nil {
					rtn.ErrorCode = jsonHookErrorShape
					return rtn
				}
				if !isMoltenHookCommand(handler.Command) {
					continue
				}
				rtn.Ours = append(rtn.Ours, AgentHookEntry{Event: event.Key, Matcher: group.Matcher, Command: handler.Command, Timeout: handler.Timeout})
				perEvent[event.Key]++
				if perEvent[event.Key] == 2 {
					rtn.Dupes = append(rtn.Dupes, event.Key)
				}
			}
		}
	}
	return rtn
}

// changes lists what applying changes: the diff against this version's hooks, then the events run twice.
func (c jsonHookConfig) changes(agent string) []AgentHookChange {
	rtn := diffAgentHookEntries(c.Ours, AgentStateHooks(agent))
	for _, event := range c.Dupes {
		rtn = append(rtn, AgentHookChange{Kind: HookChangeChanged, Event: event, Field: HookFieldDuplicate})
	}
	return rtn
}

// withoutMoltenHooks drops MoltenTerm's handlers; a group or an event left empty by that goes too. Every other
// group stays byte for byte.
func withoutMoltenHooks(events jsonObject) (jsonObject, error) {
	var rtn jsonObject
	for _, event := range events {
		var groups []json.RawMessage
		if err := json.Unmarshal(event.Value, &groups); err != nil {
			return nil, err
		}
		kept := make([]json.RawMessage, 0, len(groups))
		changed := false
		for _, raw := range groups {
			group, err := parseJSONObject(raw)
			if err != nil {
				return nil, err
			}
			at := group.index("hooks")
			if at < 0 {
				kept = append(kept, raw)
				continue
			}
			var handlers []json.RawMessage
			if err := json.Unmarshal(group[at].Value, &handlers); err != nil {
				return nil, err
			}
			var others []json.RawMessage
			for _, rawHandler := range handlers {
				var handler jsonHookHandler
				if err := json.Unmarshal(rawHandler, &handler); err != nil {
					return nil, err
				}
				if !isMoltenHookCommand(handler.Command) {
					others = append(others, rawHandler)
				}
			}
			if len(others) == len(handlers) {
				kept = append(kept, raw)
				continue
			}
			changed = true
			if len(others) == 0 {
				continue
			}
			value, err := marshalJSONNoEscape(others)
			if err != nil {
				return nil, err
			}
			rebuilt := append(jsonObject{}, group...)
			rebuilt[at].Value = value
			data, err := rebuilt.marshal()
			if err != nil {
				return nil, err
			}
			kept = append(kept, data)
		}
		if !changed {
			rtn = append(rtn, event)
			continue
		}
		if len(kept) == 0 {
			continue
		}
		value, err := marshalJSONNoEscape(kept)
		if err != nil {
			return nil, err
		}
		rtn = append(rtn, jsonMember{Key: event.Key, Value: value})
	}
	return rtn, nil
}

// withMoltenHooks appends this version's hooks, one matcher group each, after the developer's own.
func withMoltenHooks(events jsonObject, entries []AgentHookEntry) (jsonObject, error) {
	rtn := append(jsonObject{}, events...)
	for _, entry := range entries {
		handler := map[string]any{"type": "command", "command": entry.Command}
		if entry.Timeout > 0 {
			handler["timeout"] = entry.Timeout
		}
		group := map[string]any{"hooks": []any{handler}}
		if entry.Matcher != "" {
			group["matcher"] = entry.Matcher
		}
		groupData, err := marshalJSONNoEscape(group)
		if err != nil {
			return nil, err
		}
		at := rtn.index(entry.Event)
		if at < 0 {
			rtn = append(rtn, jsonMember{Key: entry.Event, Value: json.RawMessage("[" + string(groupData) + "]")})
			continue
		}
		var groups []json.RawMessage
		if err := json.Unmarshal(rtn[at].Value, &groups); err != nil {
			return nil, err
		}
		groups = append(groups, groupData)
		value, err := marshalJSONNoEscape(groups)
		if err != nil {
			return nil, err
		}
		rtn[at].Value = value
	}
	return rtn, nil
}

// rewriteJSONHookConfig returns the file with MoltenTerm's hooks replaced by this version's, or removed.
func rewriteJSONHookConfig(config jsonHookConfig, agent string, remove bool) ([]byte, error) {
	events, err := withoutMoltenHooks(config.Events)
	if err != nil {
		return nil, err
	}
	if !remove {
		if events, err = withMoltenHooks(events, AgentStateHooks(agent)); err != nil {
			return nil, err
		}
	}
	doc := append(jsonObject{}, config.Doc...)
	at := doc.index("hooks")
	switch {
	case at >= 0 && len(events) == 0 && remove:
		doc = append(doc[:at:at], doc[at+1:]...)
	case at >= 0:
		value, err := events.marshal()
		if err != nil {
			return nil, err
		}
		doc[at].Value = value
	case len(events) > 0:
		value, err := events.marshal()
		if err != nil {
			return nil, err
		}
		doc = append(doc, jsonMember{Key: "hooks", Value: value})
	}
	compact, err := doc.marshal()
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, compact, "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

// jsonHookAdapter serves Claude Code and Codex. trust: the agent runs new hooks only once the developer trusted them
// in its own /hooks screen, which MoltenTerm never answers for them.
type jsonHookAdapter struct {
	agent      string
	path       func(env AgentEnv) string
	configured func(env AgentEnv, cwd string) bool
	trust      bool
}

func (a jsonHookAdapter) offer(env AgentEnv, offer AgentHookOffer, cwd string, hooked bool, detection AgentHookDetection) AgentHookOffer {
	file := readAgentHookConfigFile(filepath.Clean(a.path(env)))
	config := readJSONHookConfig(file.Data, file.Exists)
	offer.Persistent = true
	offer.ConfigDigest = file.Digest
	offer.TrustRequired = a.trust
	for _, entry := range AgentStateHooks(a.agent) {
		offer.Events = append(offer.Events, entry.Event)
	}
	var changes []AgentHookChange
	switch {
	case file.ErrorCode != "":
		offer.Status, offer.ErrorCode = HookStatusInvalid, file.ErrorCode
	case config.ErrorCode != "":
		offer.Status, offer.ErrorCode = HookStatusInvalid, config.ErrorCode
	case len(config.Ours) == 0:
		offer.Status, offer.Action = HookStatusAbsent, HookActionInstall
	default:
		offer.Managed, offer.CanRemove = true, true
		changes = config.changes(a.agent)
		if len(changes) > 0 {
			offer.Status, offer.Action, offer.UpdateKind, offer.Changes = HookStatusDefinitionUpdate, HookActionUpdate, HookUpdateDefinition, changes
		} else if hooked {
			offer.Status, offer.Action, offer.Reason = HookStatusReporting, HookActionRemove, HookOfferHooked
		} else {
			offer.Status, offer.Action = HookStatusNotReporting, HookActionRemove
		}
	}
	offer.CanApply = offer.ErrorCode == "" && (offer.Action == HookActionInstall || offer.Action == HookActionUpdate)
	offer.UpdateKey = manualHookUpdateKey(a.agent, offer.File, offer.Status, changes)
	return decideHookOfferShow(env, a.agent, cwd, hooked, offer, a.configured)
}

func (a jsonHookAdapter) mutate(env AgentEnv, req AgentHookMutationRequest, hooked bool, detection AgentHookDetection, remove bool) (AgentHookMutationResult, error) {
	name := AgentDisplayName(a.agent)
	path := filepath.Clean(a.path(env))
	lock := agentHookConfigLock(path)
	lock.Lock()
	defer lock.Unlock()
	offer := MakeAgentHookOfferDetected(env, a.agent, "", hooked, detection)
	if req.ExpectedDigest == "" || req.UpdateKey == "" || offer.ConfigDigest != req.ExpectedDigest || offer.UpdateKey != req.UpdateKey {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("stale %s hook approval: the file changed since the offer, review it again", name)
	}
	if remove {
		if req.Action != HookActionRemove || !offer.CanRemove {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("%s hooks cannot be safely removed in this state", name)
		}
	} else if req.Action != offer.Action || !offer.CanApply {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("%s hooks cannot be applied in this state", name)
	}
	file := readAgentHookConfigFile(path)
	if file.ErrorCode != "" || file.Digest != req.ExpectedDigest {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("%s configuration changed or is unsafe", name)
	}
	config := readJSONHookConfig(file.Data, file.Exists)
	if config.ErrorCode != "" {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("%s configuration is not valid JSON hooks", name)
	}
	next, err := rewriteJSONHookConfig(config, a.agent, remove)
	if err != nil || !json.Valid(next) {
		return AgentHookMutationResult{Offer: offer}, fmt.Errorf("%s hook change would make invalid JSON: %v", name, err)
	}
	backupPath := ""
	if file.Exists {
		backupPath, err = agentHookBackup(path, file.Data, file.Mode)
		if err != nil {
			return AgentHookMutationResult{Offer: offer}, fmt.Errorf("back up %s configuration: %w", name, err)
		}
	}
	mode := file.Mode
	if mode == 0 {
		mode = 0600
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, err
	}
	if err := agentHookWriteFile(path, next, mode); err != nil {
		return AgentHookMutationResult{Offer: offer, BackupPath: backupPath}, fmt.Errorf("write %s configuration: %w", name, err)
	}
	refreshed := MakeAgentHookOfferDetected(env, a.agent, "", hooked, detection)
	return AgentHookMutationResult{Offer: refreshed, BackupPath: backupPath}, nil
}

// manualHookUpdateKey names one revision of a JSON file's offer; it leaves out the file's digest so that a dismissed
// update stays dismissed while the developer edits their other settings.
func manualHookUpdateKey(agent string, file string, status string, changes []AgentHookChange) string {
	return hookRevisionKey(struct {
		Agent   string
		File    string
		Status  string
		Changes []AgentHookChange
	}{agent, file, status, changes})
}

func hookRevisionKey(v any) string {
	key, _ := json.Marshal(v)
	return digestAgentHookConfig(key, true)
}
