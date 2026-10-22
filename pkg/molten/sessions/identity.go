// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package sessions

import (
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/review"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Who a session is and what it works on (FR-SHELL-058, #933): its agent's first name, model and effort, the MoltenTerm
// action that started it (nil for the developer's own session), its ticket and pull request, and the session that
// handed it work. Everything comes from the block's meta, the agent states and the context lookup's caches.

// reviewRecord is the part of a Review panel session's record (pkg/molten/reviewsession) the list shows; the record
// also holds the session's token, which never leaves it.
type reviewRecord struct {
	Repo      string `json:"repo"`
	Number    int    `json:"number"`
	HeadRef   string `json:"headref"`
	StartedAt int64  `json:"startedat"`
}

// originOf reads the origin a block's meta carries, and the branch it names.
func originOf(meta waveobj.MetaMapType) (*molten.SessionOrigin, string) {
	if raw, ok := meta[review.OriginMetaKey]; ok && raw != nil {
		var o review.AgentOrigin
		if utilfn.ReUnmarshal(&o, raw) == nil && o.Kind != "" {
			return &molten.SessionOrigin{Kind: o.Kind, Repo: o.Repo, Number: o.Number, At: o.At}, o.Branch
		}
	}
	if raw, ok := meta[mcpreview.SessionMetaKey]; ok && raw != nil {
		var rec reviewRecord
		if utilfn.ReUnmarshal(&rec, raw) == nil && rec.Repo != "" && rec.Number > 0 {
			return &molten.SessionOrigin{Kind: molten.SessionOriginReview, Repo: rec.Repo, Number: rec.Number, At: rec.StartedAt}, rec.HeadRef
		}
	}
	return nil, ""
}

// fillIdentity adds what the agent states and the block's meta say of a shown session.
func fillIdentity(s *Snapshot, block *waveobj.Block, ds *molten.DurableSession) {
	if ds.Agent != "" {
		info := s.Agents[block.OID]
		ds.FirstName = info.FirstName
		if ds.FirstName == "" {
			ds.FirstName = block.Meta.GetString(molten.AgentFirstNameMetaKey, "")
		}
		ds.Model, ds.ModelName, ds.Effort = info.Model, info.ModelName, info.Effort
	}
	origin, branch := originOf(block.Meta)
	ds.Origin = origin
	q := molten.SessionContextQuery{Branch: branch}
	if ds.Worktree != nil {
		q.Project = ds.Worktree.Main
		if ds.Worktree.Branch != "" {
			q.Branch = ds.Worktree.Branch
		}
	}
	if origin != nil {
		q.Repo = origin.Repo
		q.Number = origin.Number
	}
	ds.Context = contextOf(s, q)
}

func contextOf(s *Snapshot, q molten.SessionContextQuery) *molten.SessionContext {
	if q.Branch == "" && q.Number == 0 {
		return nil
	}
	var ctx *molten.SessionContext
	if s.Context != nil {
		ctx = s.Context(q)
	}
	if ctx == nil {
		ctx = &molten.SessionContext{Repo: q.Repo, Branch: q.Branch, Pr: q.Number}
	}
	if ctx.Ticket == 0 && ctx.Pr == 0 {
		return nil
	}
	return ctx
}

// linkParents points each session at the listed session whose terminal handed it work; a session never points at
// itself, and a loop of handoffs (A handed to B, then B to A) is cut where the view would nest it again.
func linkParents(s *Snapshot, list []molten.DurableSession) {
	byBlock := map[string]int{}
	for i, ds := range list {
		if ds.BlockId != "" {
			byBlock[ds.BlockId] = i
		}
	}
	for i := range list {
		ds := &list[i]
		if ds.BlockId == "" {
			continue
		}
		block := s.Blocks[ds.BlockId]
		if block == nil {
			continue
		}
		from := block.Meta.GetString(molten.HandedByMetaKey, "")
		j, ok := byBlock[from]
		if !ok || j == i {
			continue
		}
		ds.ParentId = list[j].Id
	}
	for i := range list {
		if inLoop(list, i) {
			list[i].ParentId = ""
		}
	}
}

func inLoop(list []molten.DurableSession, start int) bool {
	byId := map[string]int{}
	for i, ds := range list {
		byId[ds.Id] = i
	}
	seen := map[int]bool{start: true}
	cur := start
	for {
		next, ok := byId[list[cur].ParentId]
		if list[cur].ParentId == "" || !ok {
			return false
		}
		if seen[next] {
			return next == start
		}
		seen[next] = true
		cur = next
	}
}
