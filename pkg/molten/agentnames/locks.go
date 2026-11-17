// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentnames

import "strings"

// A first name can be locked for a project (FR-CONT-014, DS-CONT-028, #2324): the allocator never gives it to a session
// without a project nor to another project's, and a session that starts in the project settles on it when it is free.
// A project is its folder, as wavesrv resolves it for a terminal; this package only compares the strings it is given.

// The outcomes of Lock.
const (
	LockDone = "locked"
	// LockAlready: the name is already locked for this project.
	LockAlready = "already"
	// LockElsewhere: the name is locked for another project (LockResult.From) and the caller did not ask to move it.
	LockElsewhere = "elsewhere"
	// LockInvalid: no project, or a name the list does not hold (a numbered one, given when the list ran out).
	LockInvalid = "invalid"
)

// Lock is a name reserved for a project.
type Lock struct {
	Name    string `json:"name"`
	Project string `json:"project"`
}

type LockResult struct {
	Status string
	// Name: the name as the list spells it.
	Name string
	// From: the project the name was locked for, with LockElsewhere and a move.
	From string
}

// canonicalLocked is the list's spelling of name, "" when the list does not hold it.
func (a *Allocator) canonicalLocked(name string) string {
	key := nameKey(name)
	for _, n := range a.names {
		if nameKey(n) == key {
			return n
		}
	}
	return ""
}

func (a *Allocator) lockIndexLocked(name string) int {
	key := nameKey(name)
	for i, l := range a.locks {
		if nameKey(l.Name) == key {
			return i
		}
	}
	return -1
}

// lockedForLocked is the project name is locked for, "" when it is not locked.
func (a *Allocator) lockedForLocked(name string) string {
	if i := a.lockIndexLocked(name); i >= 0 {
		return a.locks[i].Project
	}
	return ""
}

// Lock reserves name for project. A name locked for another project is moved only when move says so: the new lock
// then takes the last place of the project's names.
func (a *Allocator) Lock(name string, project string, move bool) LockResult {
	a.lock.Lock()
	defer a.lock.Unlock()
	canonical := a.canonicalLocked(name)
	if canonical == "" || project == "" {
		return LockResult{Status: LockInvalid, Name: strings.TrimSpace(name)}
	}
	rtn := LockResult{Status: LockDone, Name: canonical}
	if i := a.lockIndexLocked(canonical); i >= 0 {
		current := a.locks[i].Project
		if current == project {
			rtn.Status = LockAlready
			return rtn
		}
		if !move {
			rtn.Status, rtn.From = LockElsewhere, current
			return rtn
		}
		rtn.From = current
		a.locks = append(a.locks[:i], a.locks[i+1:]...)
	}
	a.locks = append(a.locks, Lock{Name: canonical, Project: project})
	return rtn
}

// Unlock frees a locked name. It reports the lock it removed.
func (a *Allocator) Unlock(name string) (Lock, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	i := a.lockIndexLocked(name)
	if i < 0 {
		return Lock{}, false
	}
	removed := a.locks[i]
	a.locks = append(a.locks[:i], a.locks[i+1:]...)
	return removed, true
}

// Locks lists the locks in the order they were made.
func (a *Allocator) Locks() []Lock {
	a.lock.Lock()
	defer a.lock.Unlock()
	return append([]Lock{}, a.locks...)
}

// LockedFor is the project name is locked for, "" when it is not locked.
func (a *Allocator) LockedFor(name string) string {
	a.lock.Lock()
	defer a.lock.Unlock()
	return a.lockedForLocked(name)
}

// SetLocks replaces the locks (read back after a restart). A name locked twice keeps its first lock, and an entry
// without a name or a project is dropped.
func (a *Allocator) SetLocks(locks []Lock) {
	a.lock.Lock()
	defer a.lock.Unlock()
	a.locks = nil
	for _, l := range locks {
		name, project := strings.TrimSpace(l.Name), strings.TrimSpace(l.Project)
		if name == "" || project == "" || a.lockIndexLocked(name) >= 0 {
			continue
		}
		if canonical := a.canonicalLocked(name); canonical != "" {
			name = canonical
		}
		a.locks = append(a.locks, Lock{Name: name, Project: project})
	}
}

// Settle moves the owner's name to the first free name locked for project, in locking order, unless it already holds
// one of the project's. It is how a session that started in a project gets the name it is locked to: wavesrv knows the
// project of a terminal only once it has located it. The owner's old name is freed. A session holds no name when it
// ended meanwhile, and changed is then false.
func (a *Allocator) Settle(owner string, project string) (name string, changed bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	cur, ok := a.held[owner]
	if !ok {
		return "", false
	}
	if project == "" || a.lockedForLocked(cur) == project {
		return cur, false
	}
	for _, l := range a.locks {
		if l.Project != project || a.active[nameKey(l.Name)] != "" {
			continue
		}
		if a.active[nameKey(cur)] == owner {
			delete(a.active, nameKey(cur))
		}
		a.holdLocked(owner, l.Name)
		return l.Name, true
	}
	return cur, false
}
