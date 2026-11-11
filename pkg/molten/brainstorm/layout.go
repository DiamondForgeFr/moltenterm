// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"hash/fnv"
	"math"
)

// Where a node is born (DS-BOSS-009, "Layout"): MoltenTerm's own placement, pure and seeded by the ids, so that the same
// graph always stands the same way and a reloaded folder looks as it did. The centre stands at the origin; its branches
// spread around it on a ring tilted a little, wider than tall like the window; a deeper node leaves its parent away from
// where the parent came from, its siblings fanning out around that line. A node born too close to another is pushed
// aside. The view eases between these places; it never decides them.

const (
	// The world's units are about the pixels of the overview.
	firstRing  = 240.0
	branchStep = 175.0
	minGap     = 125.0
	// Wider than tall: the free space beside Brokk's group is a landscape.
	heightSquash = 0.72
	goldenAngle  = 2.399963229728653
	fanStep      = 0.62
	pushRounds   = 12
)

type vec3 [3]float64

func (a vec3) add(b vec3) vec3      { return vec3{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func (a vec3) sub(b vec3) vec3      { return vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func (a vec3) scale(s float64) vec3 { return vec3{a[0] * s, a[1] * s, a[2] * s} }
func (a vec3) dot(b vec3) float64   { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }
func (a vec3) length() float64      { return math.Sqrt(a.dot(a)) }

func (a vec3) cross(b vec3) vec3 {
	return vec3{a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]}
}

func (a vec3) unit() vec3 {
	l := a.length()
	if l < 1e-9 {
		return vec3{1, 0, 0}
	}
	return a.scale(1 / l)
}

// seed is a stable number in [0, 1) for a string.
func seed(s string) float64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return float64(h.Sum32()%100000) / 100000
}

func fract(x float64) float64 {
	return x - math.Floor(x)
}

func round1(x float64) float64 {
	return math.Round(x*10) / 10
}

func childrenOf(g Graph, id string) int {
	count := 0
	for _, n := range g.Nodes {
		if n.From == id {
			count++
		}
	}
	return count
}

// birthPos is where a new child of parent stands, given the graph it joins.
func birthPos(g Graph, parent Node, id string) [3]float64 {
	k := childrenOf(g, parent.Id)
	origin := vec3(parent.Pos)
	var pos vec3
	if parent.From == "" {
		// Around the centre: the golden angle spreads the branches evenly whatever their number, and each takes a little
		// height of its own so that the ring is not flat.
		az := goldenAngle*float64(k) + seed(parent.Id)*2*math.Pi
		el := (fract(float64(k)*0.618034+seed(id)*0.25) - 0.5) * 1.1
		dir := vec3{math.Cos(el) * math.Cos(az), math.Sin(el) * heightSquash, math.Cos(el) * math.Sin(az)}
		pos = origin.add(dir.unit().scale(firstRing))
	} else {
		grand := vec3{}
		if gp, ok := g.node(parent.From); ok {
			grand = vec3(gp.Pos)
		}
		base := origin.sub(grand).unit()
		up := vec3{0, 1, 0}
		if math.Abs(base.dot(up)) > 0.9 {
			up = vec3{1, 0, 0}
		}
		u := base.cross(up).unit()
		v := base.cross(u).unit()
		// The first child goes on almost straight, the next ones fan out on alternate sides, each a little further.
		spread := 0.22
		if k > 0 {
			spread = fanStep * float64((k+1)/2)
			if spread > 1.25 {
				spread = 1.25
			}
		}
		twist := goldenAngle*float64(k) + seed(id)*math.Pi
		side := u.scale(math.Cos(twist)).add(v.scale(math.Sin(twist)))
		dir := base.scale(math.Cos(spread)).add(side.scale(math.Sin(spread))).unit()
		dir[1] *= heightSquash
		pos = origin.add(dir.unit().scale(branchStep))
	}
	pos = pushAside(g, pos, parent.Id)
	return [3]float64{round1(pos[0]), round1(pos[1]), round1(pos[2])}
}

// pushAside moves a new node out of the others' way, never toward its parent: a few rounds, each away from the nodes
// that are too close.
func pushAside(g Graph, pos vec3, parentId string) vec3 {
	for round := 0; round < pushRounds; round++ {
		moved := false
		for _, n := range g.Nodes {
			other := vec3(n.Pos)
			gap := minGap
			if n.Id == parentId {
				gap = branchStep * 0.9
			}
			d := pos.sub(other)
			dist := d.length()
			if dist >= gap {
				continue
			}
			away := d.unit()
			if dist < 1e-6 {
				away = vec3{math.Cos(float64(round)), 0.3, math.Sin(float64(round))}.unit()
			}
			pos = pos.add(away.scale(gap - dist + 1))
			moved = true
		}
		if !moved {
			break
		}
	}
	return pos
}
