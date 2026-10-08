// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func notif(fields map[string]any) map[string]any {
	value := map[string]any{"source": "build", "title": "t", "kind": "info", "time": float64(1), "read": false}
	for k, v := range fields {
		value[k] = v
	}
	return value
}

func TestNotificationPublishAddsAndUpdatesByKey(t *testing.T) {
	now := time.UnixMilli(1000)
	ready := NotificationInput{Key: "build:gold", Source: "build", Title: "Gold is ready", Message: "Build 9c425c4",
		Actions: []NotificationAction{{Id: "reveal", Label: "Show in Finder", Kind: "gesture", Gesture: "path:reveal", Lasting: true}}}
	update := NotificationPublishUpdate(nil, ready, now, "a")
	value, _ := update["molten:notif:a"].(map[string]any)
	if value["key"] != "build:gold" || value["time"] != float64(1000) || value["updated"] != float64(1000) || value["read"] != false {
		t.Fatalf("new notification: %+v", value)
	}
	meta := waveobj.MetaMapType{"molten:notif:a": func() map[string]any {
		v := map[string]any{}
		for k, x := range value {
			v[k] = x
		}
		v["read"] = true
		return v
	}()}
	// Through JSON, as the meta comes back from the database.
	if NotificationPublishUpdate(roundTrip(t, meta), ready, now.Add(time.Second), "b") != nil {
		t.Fatal("the same content must change nothing")
	}
	ready.Message = "Build 1234567"
	changed := NotificationPublishUpdate(roundTrip(t, meta), ready, now.Add(2*time.Second), "b")
	got, _ := changed["molten:notif:a"].(map[string]any)
	if len(changed) != 1 || got["message"] != "Build 1234567" || got["read"] != false || got["updated"] != float64(3000) || got["time"] != float64(1000) {
		t.Fatalf("changed content updates in place and is unread again: %+v", changed)
	}
}

func TestNotificationResolveThenNewEpisode(t *testing.T) {
	now := time.UnixMilli(5000)
	meta := waveobj.MetaMapType{"molten:notif:a": notif(map[string]any{"key": "k"}), "molten:notif:b": notif(map[string]any{"key": "other"})}
	update := NotificationResolveUpdate(meta, "k", now)
	if len(update) != 1 || update["molten:notif:a"].(map[string]any)["resolved"] != float64(5000) {
		t.Fatalf("resolve: %+v", update)
	}
	meta["molten:notif:a"] = update["molten:notif:a"]
	next := NotificationPublishUpdate(meta, NotificationInput{Key: "k", Source: "build", Title: "again"}, now, "c")
	if _, ok := next["molten:notif:c"]; !ok {
		t.Fatalf("a resolved key starts a new notification: %+v", next)
	}
}

func TestNotificationResolveExcept(t *testing.T) {
	now := time.UnixMilli(7000)
	meta := waveobj.MetaMapType{
		"molten:notif:a": notif(map[string]any{"source": "deps", "key": "molten:deps:/site:app"}),
		"molten:notif:b": notif(map[string]any{"source": "deps", "key": "molten:deps:/site:gone"}),
		"molten:notif:c": notif(map[string]any{"source": "deps", "key": "molten:deps:/old:app", "resolved": float64(1)}),
		"molten:notif:d": notif(map[string]any{"key": "build:gold"}),
	}
	update := NotificationResolveExceptUpdate(meta, "molten:deps:", map[string]bool{"molten:deps:/site:app": true}, now)
	if len(update) != 1 || update["molten:notif:b"].(map[string]any)["resolved"] != float64(7000) {
		t.Fatalf("only the open notification of the prefix that is not kept is resolved: %+v", update)
	}
	if len(NotificationResolveExceptUpdate(meta, "", nil, now)) != 0 {
		t.Fatal("no prefix, nothing resolved")
	}
	if NotificationSubjects["deps"] != "dependencies" {
		t.Fatal("the dependencies are a subject of their own")
	}
}

func TestNotificationKeepDismissed(t *testing.T) {
	now := time.UnixMilli(9000)
	input := NotificationInput{Key: "molten:deps:/site:app", Source: "deps", Kind: "warning", Title: "site is behind app", Message: "m", KeepDismissed: true}
	meta := waveobj.MetaMapType{
		"molten:notif:a": notif(map[string]any{"source": "deps", "key": input.Key, "kind": "warning", "title": input.Title, "message": "m", "updated": float64(5000), "archived": float64(6000)}),
	}
	if update := NotificationPublishUpdate(meta, input, now, "new"); len(update) != 0 {
		t.Fatalf("an archived notification saying the same stays archived: %+v", update)
	}
	changed := input
	changed.Message = "a later change"
	if update := NotificationPublishUpdate(meta, changed, now, "new"); update["molten:notif:new"] == nil {
		t.Fatalf("a new situation is told again: %+v", update)
	}
	plain := input
	plain.KeepDismissed = false
	if update := NotificationPublishUpdate(meta, plain, now, "new"); update["molten:notif:new"] == nil {
		t.Fatalf("other publishers open a new episode: %+v", update)
	}
}

func TestNotificationRetention(t *testing.T) {
	now := time.UnixMilli(NotificationClosedRetention.Milliseconds() + 10000)
	recent := float64(now.UnixMilli() - 100)
	meta := waveobj.MetaMapType{
		"molten:notif:old":     notif(map[string]any{"read": true}),
		"molten:notif:openOld": notif(map[string]any{"key": "k", "read": true}),
	}
	for i := 0; i < MaxClosedNotificationsPerKey+2; i++ {
		meta["molten:notif:r"+string(rune('a'+i))] = notif(map[string]any{"key": "same", "time": recent + float64(i), "resolved": recent + float64(i)})
	}
	update := NotificationPublishUpdate(meta, NotificationInput{Source: "agent", Title: "bell"}, now, "new")
	var dropped []string
	for k, v := range update {
		if v == nil {
			dropped = append(dropped, strings.TrimPrefix(k, NotificationKeyPrefix))
		}
	}
	want := []string{"old", "ra", "rb"}
	if !reflect.DeepEqual(sortedStrings(dropped), want) {
		t.Fatalf("dropped %v, want %v (open ones never dropped)", dropped, want)
	}
}

func TestNotificationActionsCapped(t *testing.T) {
	input := NotificationInput{Source: "build", Title: "t", Actions: []NotificationAction{{Id: "a", Label: "A", Kind: "open"}, {Id: "b", Label: "B", Kind: "open"}, {Id: "c", Label: "C", Kind: "open"}, {Id: "d", Label: "D", Kind: "open"}}}
	value := NotificationPublishUpdate(nil, input, time.UnixMilli(1), "x")["molten:notif:x"].(map[string]any)
	if actions, _ := value["actions"].([]any); len(actions) != MaxNotificationActions {
		t.Fatalf("actions: %+v", value["actions"])
	}
}

func roundTrip(t *testing.T, meta waveobj.MetaMapType) waveobj.MetaMapType {
	t.Helper()
	data, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	var rtn waveobj.MetaMapType
	if err := json.Unmarshal(data, &rtn); err != nil {
		t.Fatal(err)
	}
	return rtn
}

func sortedStrings(s []string) []string {
	sort.Strings(s)
	return s
}

func TestNotificationDeliveryFollowsTheSubjectsChoice(t *testing.T) {
	now := time.UnixMilli(1000)
	meta := waveobj.MetaMapType{NotificationPrefsMetaKey: map[string]any{"builds": "off", "agents": "quiet"}}
	if update := NotificationPublishUpdate(meta, NotificationInput{Source: "build", Title: "built"}, now, "a"); update != nil {
		t.Fatalf("builds are off: %v", update)
	}
	warn := NotificationPublishUpdate(meta, NotificationInput{Source: "build", Kind: "warning", Title: "slow"}, now, "b")
	if v, _ := warn["molten:notif:b"].(map[string]any); v == nil || v["read"] != true {
		t.Fatalf("a warning is never dropped, at most quiet: %v", warn)
	}
	fail := NotificationPublishUpdate(meta, NotificationInput{Source: "build", Kind: "error", Title: "stopped"}, now, "c")
	if v, _ := fail["molten:notif:c"].(map[string]any); v == nil || v["read"] != false {
		t.Fatalf("an error is always told: %v", fail)
	}
	agent := NotificationPublishUpdate(meta, NotificationInput{Source: "agent", Title: "done"}, now, "d")
	if v, _ := agent["molten:notif:d"].(map[string]any); v == nil || v["read"] != true {
		t.Fatalf("agents are quiet: kept, already read: %v", agent)
	}
	other := NotificationPublishUpdate(meta, NotificationInput{Source: "ci", Title: "green"}, now, "e")
	if v, _ := other["molten:notif:e"].(map[string]any); v == nil || v["read"] != false {
		t.Fatalf("an unchosen subject notifies: %v", other)
	}
}
