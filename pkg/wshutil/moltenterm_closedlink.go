// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wshutil

import (
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
)

// #2334: a link whose proxy was closed while it stayed registered had its backlog retried every 50 ms, forever, each
// send panicking and logging under the router lock. A closed link is now dropped, the backlog is sent outside the
// router lock, and the backlog's log lines are printed after the lock is released, at most one per link and kind per
// minute.

const BacklogLogInterval = time.Minute

const (
	backlogLogReached = "reached"
	backlogLogCleared = "cleared"
	backlogLogGone    = "gone"
)

// closableRpcClient is a link client that can tell it will never accept a message again (WshRpcProxy).
type closableRpcClient interface {
	IsClosed() bool
}

type backlogLogKey struct {
	linkId baseds.LinkId
	kind   string
}

type backlogRoundItem struct {
	linkId  baseds.LinkId
	client  AbstractRpcClient
	backlog []backlogMessageWrap
	sent    int
	gone    bool
}

func isLinkClientGone(client AbstractRpcClient) bool {
	closable, ok := client.(closableRpcClient)
	return ok && closable.IsClosed()
}

// allowBacklogLog_withlock says whether a backlog line of this kind may be logged for the link now, and records it.
func (router *WshRouter) allowBacklogLog_withlock(linkId baseds.LinkId, kind string, now time.Time) bool {
	if router.backlogLogAt == nil {
		router.backlogLogAt = make(map[backlogLogKey]time.Time)
	}
	for key, at := range router.backlogLogAt {
		if now.Sub(at) >= BacklogLogInterval {
			delete(router.backlogLogAt, key)
		}
	}
	key := backlogLogKey{linkId: linkId, kind: kind}
	if _, logged := router.backlogLogAt[key]; logged {
		return false
	}
	router.backlogLogAt[key] = now
	return true
}

func printBacklogLogLines(lines []string) {
	for _, line := range lines {
		log.Printf("%s\n", line)
	}
}

// dropGoneLinkBacklog_withlock forgets a gone link's backlog and returns the line to log, "" when rate-limited.
func (router *WshRouter) dropGoneLinkBacklog_withlock(linkId baseds.LinkId, now time.Time) string {
	dropped := len(router.linkMsgBacklog[linkId])
	delete(router.linkMsgBacklog, linkId)
	delete(router.backlogHighWaterMark, linkId)
	if !router.allowBacklogLog_withlock(linkId, backlogLogGone, now) {
		return ""
	}
	return fmt.Sprintf("[router] linkid=%d is closed, unregistering it and dropping %d queued messages", linkId, dropped)
}

// takeBacklogRound copies the backlog of every registered link, and drops the backlogs of links already gone.
func (router *WshRouter) takeBacklogRound() ([]*backlogRoundItem, []string) {
	router.lock.Lock()
	defer router.lock.Unlock()
	now := time.Now()
	var items []*backlogRoundItem
	var lines []string
	for linkId, backlog := range router.linkMsgBacklog {
		lm := router.linkMap[linkId]
		if lm == nil {
			highWater := router.backlogHighWaterMark[linkId]
			if highWater > 0 && router.allowBacklogLog_withlock(linkId, backlogLogCleared, now) {
				lines = append(lines, fmt.Sprintf("[router] backlog for linkid=%d cleared, link gone (highwater mark was %d messages)", linkId, highWater))
			}
			delete(router.linkMsgBacklog, linkId)
			delete(router.backlogHighWaterMark, linkId)
			continue
		}
		items = append(items, &backlogRoundItem{
			linkId:  linkId,
			client:  lm.client,
			backlog: append([]backlogMessageWrap(nil), backlog...),
		})
	}
	return items, lines
}

// finishBacklogRound removes what the round sent from each backlog. Only a round removes messages from a backlog, and
// rounds never overlap, so the first sent messages of the current backlog are the ones the round sent.
func (router *WshRouter) finishBacklogRound(items []*backlogRoundItem) ([]baseds.LinkId, []string) {
	router.lock.Lock()
	defer router.lock.Unlock()
	now := time.Now()
	var gone []baseds.LinkId
	var lines []string
	for _, item := range items {
		if item.gone {
			gone = append(gone, item.linkId)
			if line := router.dropGoneLinkBacklog_withlock(item.linkId, now); line != "" {
				lines = append(lines, line)
			}
			continue
		}
		backlog := router.linkMsgBacklog[item.linkId]
		sent := min(item.sent, len(backlog))
		backlog = backlog[sent:]
		if len(backlog) > 0 {
			router.linkMsgBacklog[item.linkId] = backlog
			continue
		}
		highWater := router.backlogHighWaterMark[item.linkId]
		if highWater > 0 && router.allowBacklogLog_withlock(item.linkId, backlogLogCleared, now) {
			lines = append(lines, fmt.Sprintf("[router] backlog for linkid=%d cleared (highwater mark was %d messages)", item.linkId, highWater))
		}
		delete(router.linkMsgBacklog, item.linkId)
		delete(router.backlogHighWaterMark, item.linkId)
	}
	return gone, lines
}

func (router *WshRouter) runBacklogRound() ([]baseds.LinkId, []string) {
	router.backlogRoundLock.Lock()
	defer router.backlogRoundLock.Unlock()
	items, lines := router.takeBacklogRound()
	for _, item := range items {
		item.sent, item.gone = drainLinkBacklog(item.client, item.backlog)
	}
	gone, finishLines := router.finishBacklogRound(items)
	return gone, append(lines, finishLines...)
}

func (router *WshRouter) unregisterGoneLinks(linkIds []baseds.LinkId) {
	for _, linkId := range linkIds {
		router.UnregisterLink(linkId)
	}
}
