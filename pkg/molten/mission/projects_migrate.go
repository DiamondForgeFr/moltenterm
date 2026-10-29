// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/attention"
	"github.com/wavetermdev/waveterm/pkg/molten/railorder"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// A workspace is a product made of typed projects (FR-SHELL-087). Once, the groups of the rail become projects: the
// local groups (FR-MC-032) and the project products (FR-MC-027). The group's first workspace with a project folder
// takes the other members' folders as its projects, so its Pilotage follows them all. It is additive: no workspace is
// merged or deleted (their views, terminals and agents stay), the group records stay for the rail, and nothing is
// written in any project. A member without a folder cannot become a project: it stays a workspace of its own and the
// notification says so.

// must match frontend/moltenterm-shell/sidebar/workspace-projects.ts
const (
	ProjectsMetaKey         = "molten:projects"
	CurrentProjectMetaKey   = "molten:currentproject"
	ProjectTypeMetaKey      = "molten:projecttype"
	ProjectsMigratedMetaKey = "molten:projectsmigrated"
	FirstProjectId          = "p1"
	ProjectsNoticeKeyPrefix = "molten:projectsmigrate:"
	projectsMigrateTimeout  = 30 * time.Second
)

type MigrateWorkspace struct {
	Id      string
	Name    string
	Dir     string
	Type    string
	HasList bool
}

// MigrateGroup is a group's workspaces in rail order.
type MigrateGroup struct {
	Name    string
	Members []string
}

type WorkspaceProject struct {
	Id     string `json:"id"`
	Type   string `json:"type"`
	Dir    string `json:"dir"`
	Branch string `json:"branch,omitempty"`
}

type MigratePlan struct {
	HostId    string
	HostName  string
	GroupName string
	// The host's whole list, its own project first.
	Projects []WorkspaceProject
	// The workspaces whose folders became projects, and those without a folder that stay on their own.
	Moved []string
	Kept  []string
}

// projectTypeFromName names a member's project after its workspace: "Notulia Mobile" in the product "Notulia" is
// "Mobile"; the product's name is never repeated.
func projectTypeFromName(name string, product string) string {
	name = strings.TrimSpace(name)
	product = strings.TrimSpace(product)
	if product != "" && len(name) > len(product) && strings.EqualFold(name[:len(product)], product) {
		rest := strings.TrimLeft(name[len(product):], " -–—·:/_")
		if rest != "" && rest != name[len(product):] {
			return rest
		}
	}
	return name
}

func sameProjectDir(a string, b string) bool {
	return a != "" && b != "" && filepath.Clean(a) == filepath.Clean(b)
}

// PlanProjectsMigration says what each group becomes. A workspace that already holds a project list is the user's
// own choice and is left alone; a workspace is the host of one plan at most.
func PlanProjectsMigration(workspaces map[string]MigrateWorkspace, groups []MigrateGroup) []MigratePlan {
	plans := []MigratePlan{}
	hosted := map[string]bool{}
	for _, group := range groups {
		members := []MigrateWorkspace{}
		for _, id := range group.Members {
			if ws, ok := workspaces[id]; ok {
				members = append(members, ws)
			}
		}
		if len(members) < 2 {
			continue
		}
		hostAt := -1
		for i, ws := range members {
			if ws.Dir != "" {
				hostAt = i
				break
			}
		}
		if hostAt < 0 {
			continue
		}
		host := members[hostAt]
		if host.HasList || hosted[host.Id] {
			continue
		}
		hosted[host.Id] = true
		plan := MigratePlan{HostId: host.Id, HostName: host.Name, GroupName: group.Name,
			Projects: []WorkspaceProject{{Id: FirstProjectId, Type: host.Type, Dir: host.Dir}}}
		for i, ws := range members {
			if i == hostAt {
				continue
			}
			if ws.Dir == "" {
				plan.Kept = append(plan.Kept, ws.Name)
				continue
			}
			taken := false
			for _, p := range plan.Projects {
				if sameProjectDir(p.Dir, ws.Dir) {
					taken = true
				}
			}
			if taken {
				continue
			}
			kind := ws.Type
			if kind == "" {
				kind = projectTypeFromName(ws.Name, host.Name)
			}
			plan.Projects = append(plan.Projects, WorkspaceProject{
				Id:   fmt.Sprintf("p%d", len(plan.Projects)+1),
				Type: kind,
				Dir:  ws.Dir,
			})
			plan.Moved = append(plan.Moved, ws.Name)
		}
		if len(plan.Moved) == 0 && len(plan.Kept) == 0 {
			continue
		}
		plans = append(plans, plan)
	}
	return plans
}

func projectsMetaValue(projects []WorkspaceProject) []any {
	rtn := make([]any, len(projects))
	for i, p := range projects {
		value := map[string]any{"id": p.Id, "type": p.Type, "dir": p.Dir}
		if p.Branch != "" {
			value["branch"] = p.Branch
		}
		rtn[i] = value
	}
	return rtn
}

// projectsMigrationNotice tells what a plan did.
func projectsMigrationNotice(plan MigratePlan) molten.NotificationInput {
	moved := strings.Join(plan.Moved, ", ")
	kept := strings.Join(plan.Kept, ", ")
	types := []string{}
	for _, p := range plan.Projects {
		label := p.Type
		if label == "" {
			label = filepath.Base(p.Dir)
		}
		types = append(types, label)
	}
	projects := strings.Join(types, ", ")
	input := molten.NotificationInput{
		Key:         ProjectsNoticeKeyPrefix + plan.HostId,
		Source:      "moltenterm",
		Kind:        "info",
		WorkspaceId: plan.HostId,
	}
	if len(plan.Moved) == 0 {
		input.Title = fmt.Sprintf("%s stays a group", plan.GroupName)
		input.TitleText = uimsg.Make("notif.projects.keptTitle", "group", plan.GroupName)
		input.Message = fmt.Sprintf("The group %[2]s stays as it was: its other workspaces have no project folder to bring in (%[1]s).", kept, plan.GroupName)
		input.MessageText = uimsg.Make("notif.projects.kept", "workspaces", kept, "group", plan.GroupName)
		return input
	}
	input.Title = fmt.Sprintf("%s now holds its group's projects", plan.HostName)
	input.TitleText = uimsg.Make("notif.projects.migratedTitle", "workspace", plan.HostName)
	if len(plan.Kept) == 0 {
		input.Message = fmt.Sprintf("%s is now a product with the projects %s, and the Integration panel follows them all. The other workspaces keep their views and agents (%s): delete them when you no longer need them.", plan.HostName, projects, moved)
		input.MessageText = uimsg.Make("notif.projects.migrated", "workspace", plan.HostName, "projects", projects, "workspaces", moved)
		return input
	}
	input.Message = fmt.Sprintf("%s is now a product with the projects %s, and the Integration panel follows them all. The other workspaces keep their views and agents (%s): delete them when you no longer need them. Workspaces without a project folder stay on their own: %s.", plan.HostName, projects, moved, kept)
	input.MessageText = uimsg.Make("notif.projects.migratedKept", "workspace", plan.HostName, "projects", projects, "workspaces", moved,
		"kept", kept)
	return input
}

func publishWaveObj(ctx context.Context, oref waveobj.ORef) {
	obj, err := wstore.DBGetORef(ctx, oref)
	if err != nil {
		log.Printf("molten: reading %s for its update event: %v\n", oref, err)
		return
	}
	wps.Broker.Publish(wps.WaveEvent{
		Event:  wps.Event_WaveObjUpdate,
		Scopes: []string{oref.String()},
		Data: waveobj.WaveObjUpdate{
			UpdateType: waveobj.UpdateType_Update,
			OType:      obj.GetOType(),
			OID:        waveobj.GetOID(obj),
			Obj:        obj,
		},
	})
}

// migrationGroups reads the groups to migrate: the project products (two members or more) by their members' first
// workspaces, then the local groups.
func migrationGroups(ctx context.Context, client *waveobj.Client, names map[string]string) ([]MigrateGroup, error) {
	links, err := WorkspaceLinks(ctx)
	if err != nil {
		return nil, err
	}
	groups := []MigrateGroup{}
	for _, product := range molten.ResolveGroups(links, molten.ReadProject) {
		if len(product.Members) < 2 {
			continue
		}
		group := MigrateGroup{Name: product.Name}
		for _, member := range product.Members {
			if len(member.Workspaces) > 0 {
				group.Members = append(group.Members, member.Workspaces[0].Id)
			}
		}
		groups = append(groups, group)
	}
	for _, local := range railorder.ReadGroups(client.Meta) {
		name := local.Name
		if name == "" && len(local.Members) > 0 {
			name = names[local.Members[0]]
		}
		groups = append(groups, MigrateGroup{Name: name, Members: local.Members})
	}
	return groups, nil
}

// MigrateGroupsToProjects runs once per installation: the client meta remembers it ran.
func MigrateGroupsToProjects(ctx context.Context) error {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil {
		return fmt.Errorf("reading the client: %w", err)
	}
	if client.Meta.GetBool(ProjectsMigratedMetaKey, false) {
		return nil
	}
	all, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](ctx, waveobj.OType_Workspace)
	if err != nil {
		return err
	}
	workspaces := map[string]MigrateWorkspace{}
	names := map[string]string{}
	for _, ws := range all {
		_, hasList := ws.Meta[ProjectsMetaKey]
		workspaces[ws.OID] = MigrateWorkspace{
			Id:      ws.OID,
			Name:    ws.Name,
			Dir:     ws.Meta.GetString(molten.ProjectMetaKey, ""),
			Type:    strings.TrimSpace(ws.Meta.GetString(ProjectTypeMetaKey, "")),
			HasList: hasList,
		}
		names[ws.OID] = ws.Name
	}
	groups, err := migrationGroups(ctx, client, names)
	if err != nil {
		return err
	}
	for _, plan := range PlanProjectsMigration(workspaces, groups) {
		oref := waveobj.MakeORef(waveobj.OType_Workspace, plan.HostId)
		update := waveobj.MetaMapType{ProjectsMetaKey: projectsMetaValue(plan.Projects), CurrentProjectMetaKey: FirstProjectId}
		if len(plan.Moved) > 0 {
			if err := wstore.UpdateObjectMeta(ctx, oref, update, false); err != nil {
				return err
			}
			publishWaveObj(ctx, oref)
		}
		if err := attention.PublishNotification(ctx, projectsMigrationNotice(plan)); err != nil {
			log.Printf("molten: projects migration: notifying %s: %v\n", plan.HostName, err)
		}
	}
	clientRef := waveobj.MakeORef(waveobj.OType_Client, client.OID)
	if err := wstore.UpdateObjectMeta(ctx, clientRef, waveobj.MetaMapType{ProjectsMigratedMetaKey: true}, false); err != nil {
		return err
	}
	publishWaveObj(ctx, clientRef)
	return nil
}

func startProjectsMigration() {
	go func() {
		defer func() {
			panichandler.PanicHandler("molten:projectsmigrate", recover())
		}()
		ctx, cancel := context.WithTimeout(context.Background(), projectsMigrateTimeout)
		defer cancel()
		if err := MigrateGroupsToProjects(ctx); err != nil {
			log.Printf("molten: projects migration: %v\n", err)
		}
	}()
}
