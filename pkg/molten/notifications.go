// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// What wavesrv publishes in the notification center (FR-MC-010, DS-MC-009): the same rules as
// frontend/moltenterm-shell/notifications-model.ts, which the windows apply to what they publish. Keep both in step.

// must match frontend/moltenterm-shell/notifications-model.ts
const (
	NotificationKeyPrefix        = "molten:notif:"
	MaxNotifications             = 500
	NotificationClosedRetention  = 30 * 24 * time.Hour
	MaxClosedNotificationsPerKey = 20
	MaxNotificationActions       = 2
)

type NotificationAction struct {
	Id          string         `json:"id"`
	Label       string         `json:"label"`
	Kind        string         `json:"kind"`
	WorkspaceId string         `json:"workspaceid,omitempty"`
	TabId       string         `json:"tabid,omitempty"`
	BlockId     string         `json:"blockid,omitempty"`
	View        string         `json:"view,omitempty"`
	Gesture     string         `json:"gesture,omitempty"`
	Args        map[string]any `json:"args,omitempty"`
	Lasting     bool           `json:"lasting,omitempty"`
}

type NotificationInput struct {
	Key         string               `json:"key,omitempty"`
	Source      string               `json:"source"`
	Title       string               `json:"title"`
	Message     string               `json:"message,omitempty"`
	Kind        string               `json:"kind,omitempty"`
	WorkspaceId string               `json:"workspaceid,omitempty"`
	TabId       string               `json:"tabid,omitempty"`
	BlockId     string               `json:"blockid,omitempty"`
	Actions     []NotificationAction `json:"actions,omitempty"`
}

type storedNotification struct {
	id    string
	value map[string]any
}

func (n storedNotification) str(key string) string {
	s, _ := n.value[key].(string)
	return s
}

func (n storedNotification) num(key string) (float64, bool) {
	f, ok := n.value[key].(float64)
	return f, ok
}

func (n storedNotification) updated() float64 {
	if f, ok := n.num("updated"); ok {
		return f
	}
	f, _ := n.num("time")
	return f
}

func (n storedNotification) read() bool {
	b, _ := n.value["read"].(bool)
	return b
}

func (n storedNotification) closedMark() bool {
	_, resolved := n.num("resolved")
	_, archived := n.num("archived")
	return resolved || archived
}

// open: neither resolved nor archived; without a key it is one moment, open until read.
func (n storedNotification) open() bool {
	if n.closedMark() {
		return false
	}
	if n.str("key") != "" {
		return true
	}
	return !n.read()
}

func readStoredNotifications(meta waveobj.MetaMapType) []storedNotification {
	var rtn []storedNotification
	for key, value := range meta {
		if !strings.HasPrefix(key, NotificationKeyPrefix) {
			continue
		}
		m, ok := value.(map[string]any)
		if !ok {
			continue
		}
		rtn = append(rtn, storedNotification{id: strings.TrimPrefix(key, NotificationKeyPrefix), value: m})
	}
	return rtn
}

func capActions(actions []NotificationAction) []NotificationAction {
	if len(actions) > MaxNotificationActions {
		return actions[:MaxNotificationActions]
	}
	return actions
}

func payloadOf(kind string, title string, message string, actions []NotificationAction) string {
	if kind == "" {
		kind = "info"
	}
	if actions == nil {
		actions = []NotificationAction{}
	}
	data, _ := json.Marshal(struct {
		Kind    string               `json:"kind"`
		Title   string               `json:"title"`
		Message string               `json:"message"`
		Actions []NotificationAction `json:"actions"`
	}{kind, title, message, capActions(actions)})
	return string(data)
}

func storedPayload(n storedNotification) string {
	var actions []NotificationAction
	if raw, ok := n.value["actions"]; ok {
		data, _ := json.Marshal(raw)
		json.Unmarshal(data, &actions)
	}
	return payloadOf(n.str("kind"), n.str("title"), n.str("message"), actions)
}

// notificationPruneIds returns what the retention rule drops: closed notifications past their time, beyond
// MaxClosedNotificationsPerKey for their key, then the oldest closed ones while the total is above MaxNotifications.
// An open notification is never dropped.
func notificationPruneIds(entries []storedNotification, now time.Time) []string {
	var closed []storedNotification
	for _, n := range entries {
		if !n.open() {
			closed = append(closed, n)
		}
	}
	sort.SliceStable(closed, func(i, j int) bool { return closed[i].updated() < closed[j].updated() })
	drop := map[string]bool{}
	nowMs := float64(now.UnixMilli())
	for _, n := range closed {
		if nowMs-n.updated() > float64(NotificationClosedRetention.Milliseconds()) {
			drop[n.id] = true
		}
	}
	byKey := map[string][]storedNotification{}
	for _, n := range closed {
		if n.str("key") == "" || drop[n.id] {
			continue
		}
		byKey[n.str("key")] = append(byKey[n.str("key")], n)
	}
	for _, group := range byKey {
		for i := 0; i < len(group)-MaxClosedNotificationsPerKey; i++ {
			drop[group[i].id] = true
		}
	}
	total := len(entries) - len(drop)
	for _, n := range closed {
		if total <= MaxNotifications {
			break
		}
		if !drop[n.id] {
			drop[n.id] = true
			total--
		}
	}
	var ids []string
	for id := range drop {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func inputValue(input NotificationInput) map[string]any {
	data, _ := json.Marshal(input)
	var value map[string]any
	json.Unmarshal(data, &value)
	if value["kind"] == nil {
		value["kind"] = "info"
	}
	if _, ok := value["actions"]; !ok {
		value["actions"] = []any{}
	}
	return value
}

// must match notification-rules.ts
const (
	NotificationPrefsMetaKey  = "molten:notifprefs"
	NotificationDeliverNotify = "notify"
	NotificationDeliverQuiet  = "quiet"
	NotificationDeliverOff    = "off"
)

// The subject of each source, which the user chooses to hear (FR-MC-019).
var NotificationSubjects = map[string]string{
	"agent":      "agents",
	"build":      "builds",
	"ci":         "ci",
	"release":    "releases",
	"moltenterm": "updates",
	"mod":        "mods",
}

// NotificationDelivery is how a message is said, from the user's choice for its subject: an error is always told, a
// warning at worst kept quietly (read), information follows the choice.
func NotificationDelivery(meta waveobj.MetaMapType, input NotificationInput) string {
	subject, ok := NotificationSubjects[input.Source]
	if !ok || input.Kind == "error" {
		return NotificationDeliverNotify
	}
	prefs, _ := meta[NotificationPrefsMetaKey].(map[string]any)
	chosen, _ := prefs[subject].(string)
	switch {
	case chosen == NotificationDeliverOff && input.Kind == "warning":
		return NotificationDeliverQuiet
	case chosen == NotificationDeliverQuiet || chosen == NotificationDeliverOff:
		return chosen
	}
	return NotificationDeliverNotify
}

// NotificationPublishUpdate is the client meta update that publishes a notification, or nil when the open
// notification of its key already says the same, or when the user turned its subject off. A changed one is updated
// in place and unread again, unless its subject is quiet.
func NotificationPublishUpdate(meta waveobj.MetaMapType, input NotificationInput, now time.Time, id string) waveobj.MetaMapType {
	delivery := NotificationDelivery(meta, input)
	if delivery == NotificationDeliverOff {
		return nil
	}
	read := delivery == NotificationDeliverQuiet
	input.Actions = capActions(input.Actions)
	entries := readStoredNotifications(meta)
	nowMs := float64(now.UnixMilli())
	if input.Key != "" {
		for _, n := range entries {
			if n.str("key") != input.Key || !n.open() {
				continue
			}
			if storedPayload(n) == payloadOf(input.Kind, input.Title, input.Message, input.Actions) {
				return nil
			}
			value := map[string]any{}
			for k, v := range n.value {
				value[k] = v
			}
			for k, v := range inputValue(input) {
				value[k] = v
			}
			value["updated"] = nowMs
			value["read"] = read
			return waveobj.MetaMapType{NotificationKeyPrefix + n.id: value}
		}
	}
	value := inputValue(input)
	value["time"] = nowMs
	value["updated"] = nowMs
	value["read"] = read
	entry := storedNotification{id: id, value: value}
	update := waveobj.MetaMapType{NotificationKeyPrefix + id: value}
	for _, dropId := range notificationPruneIds(append(entries, entry), now) {
		if dropId != id {
			update[NotificationKeyPrefix+dropId] = nil
		}
	}
	return update
}

// NotificationResolveUpdate closes the situation of a key: every open notification for it.
func NotificationResolveUpdate(meta waveobj.MetaMapType, key string, now time.Time) waveobj.MetaMapType {
	update := waveobj.MetaMapType{}
	if key == "" {
		return update
	}
	for _, n := range readStoredNotifications(meta) {
		if n.str("key") != key || n.closedMark() {
			continue
		}
		value := map[string]any{}
		for k, v := range n.value {
			value[k] = v
		}
		value["resolved"] = float64(now.UnixMilli())
		update[NotificationKeyPrefix+n.id] = value
	}
	return update
}
