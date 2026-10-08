// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
)

// A stale dependency is told once in the notification center (FR-MC-029-AC5, FR-MC-010): one notification per
// dependent and source, updated in place when the source changes again, and resolved when the flag clears. Its text
// depends only on the source's commits, so a refresh that finds the same commits says nothing again.

// must match frontend/moltenterm-shell/notifications-model.ts and notification-rules.ts
const (
	DepNotificationSource    = "deps"
	DepNotificationKeyPrefix = "molten:deps:"
	// The notification's Sync action; the handler is registered by the Sync story (FR-MC-030).
	DepSyncGesture        = "dependency:sync"
	depNoticeShownPaths   = 3
	depNoticeShownTickets = 5
	depNoticeTimeout      = 10 * time.Second
)

// DependencyNotices is what the notification center should hold for the dependencies: the notices to publish, and the
// keys to leave as they are (a dependency that could not be read this time). Every other open dependency notification
// is resolved.
type DependencyNotices struct {
	Notices []molten.NotificationInput `json:"notices"`
	Keep    []string                   `json:"keep"`
}

// DepNotificationKey keys a dependency's notification by dependent and source. A second declaration on the same source
// gets its own.
func DepNotificationKey(dependentDir string, sourceName string, occurrence int) string {
	key := DepNotificationKeyPrefix + dependentDir + ":" + strings.ToLower(strings.TrimSpace(sourceName))
	if occurrence > 0 {
		key += fmt.Sprintf(":%d", occurrence+1)
	}
	return key
}

func listShown(items []string, shown int) string {
	if len(items) <= shown {
		return strings.Join(items, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(items[:shown], ", "), len(items)-shown)
}

func depCommitCount(dep DependencyState) string {
	count := fmt.Sprintf("%d commit", len(dep.Commits))
	if len(dep.Commits) != 1 {
		count += "s"
	}
	if dep.MoreCommits {
		count = fmt.Sprintf("more than %d commits", len(dep.Commits))
	}
	return count
}

// DepTickets lists the tickets of the commits since the last sync, newest first, once each.
func DepTickets(dep DependencyState) []string {
	var tickets []string
	seen := map[string]bool{}
	for _, commit := range dep.Commits {
		for _, ticket := range commit.Tickets {
			if !seen[ticket] {
				seen[ticket] = true
				tickets = append(tickets, "#"+ticket)
			}
		}
	}
	return tickets
}

func dependencyNotice(dependent GroupMemberInfo, dep DependencyState, key string) molten.NotificationInput {
	changed := dep.Changed
	if len(changed) == 0 {
		changed = dep.Paths
	}
	message := fmt.Sprintf("%s changed on %s since the last sync: %s", listShown(changed, depNoticeShownPaths), dep.Branch, depCommitCount(dep))
	if dep.Synced == nil {
		message = fmt.Sprintf("%s was never synced: %s of %s touch %s on %s", dependent.Name, depCommitCount(dep), dep.SourceName,
			listShown(changed, depNoticeShownPaths), dep.Branch)
	}
	if tickets := DepTickets(dep); len(tickets) > 0 {
		message += " (" + listShown(tickets, depNoticeShownTickets) + ")"
	}
	if dep.Source != nil {
		message += fmt.Sprintf(", newest %s.", shortSha(dep.Source.Sha))
	}
	input := molten.NotificationInput{
		Key:     key,
		Source:  DepNotificationSource,
		Kind:    "warning",
		Title:   fmt.Sprintf("%s is behind %s", dependent.Name, dep.SourceName),
		Message: message,
	}
	if len(dependent.Workspaces) > 0 {
		input.WorkspaceId = dependent.Workspaces[0].Id
	}
	if dep.Sync != "" {
		input.Actions = append(input.Actions, molten.NotificationAction{Id: "sync", Label: "Sync", Kind: "gesture", Gesture: DepSyncGesture,
			Args: map[string]any{"dir": dependent.Dir, "project": dep.SourceName, "index": dep.Index}})
	}
	input.Actions = append(input.Actions, molten.NotificationAction{Id: "open", Label: "Open", Kind: "open", View: ProjectView})
	return input
}

// dependencyNotices reads from the groups which dependency notifications should be open.
func dependencyNotices(answer GroupsAnswer) DependencyNotices {
	notices := DependencyNotices{Notices: []molten.NotificationInput{}, Keep: []string{}}
	for _, group := range answer.Groups {
		for _, member := range group.Members {
			occurrences := map[string]int{}
			for _, dep := range member.State.Deps {
				if dep.SourceName == "" {
					continue
				}
				source := strings.ToLower(strings.TrimSpace(dep.SourceName))
				key := DepNotificationKey(member.Dir, dep.SourceName, occurrences[source])
				occurrences[source]++
				switch {
				case dep.Flagged():
					notices.Notices = append(notices.Notices, dependencyNotice(member, dep, key))
				case dep.State == DepStateError:
					notices.Keep = append(notices.Keep, key)
				}
			}
		}
	}
	return notices
}

// tellDependencies brings the notification center in line with the dependencies, when they changed since last told.
func (g *Groups) tellDependencies(answer GroupsAnswer) {
	if g.notify == nil {
		return
	}
	notices := dependencyNotices(answer)
	data, err := json.Marshal(notices)
	if err != nil || !g.claimNotices(string(data)) {
		return
	}
	if err := g.notify(notices); err != nil {
		log.Printf("molten: telling the stale dependencies: %v\n", err)
		g.claimNotices("")
	}
}

func (g *Groups) claimNotices(data string) bool {
	g.lock.Lock()
	defer g.lock.Unlock()
	if data != "" && data == g.noticed {
		return false
	}
	g.noticed = data
	return true
}

// notifyDependencies writes the notices in the notification center and resolves the dependency notifications that are
// no longer stale: cleared, removed, or whose source or branch is gone.
func notifyDependencies(notices DependencyNotices) error {
	ctx, cancel := context.WithTimeout(context.Background(), depNoticeTimeout)
	defer cancel()
	keep := map[string]bool{}
	for _, key := range notices.Keep {
		keep[key] = true
	}
	for _, input := range notices.Notices {
		keep[input.Key] = true
		if err := attention.PublishNotification(ctx, input); err != nil {
			return err
		}
	}
	return attention.ResolveNotificationsExcept(ctx, DepNotificationKeyPrefix, keep)
}
