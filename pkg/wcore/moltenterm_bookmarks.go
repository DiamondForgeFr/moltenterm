// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package wcore

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/bookmarks"
	"github.com/wavetermdev/waveterm/pkg/molten/contexts"
	"github.com/wavetermdev/waveterm/pkg/panichandler"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// The bookmarks of the web page panel live in the client's meta, each at one or several places (#2531,
// pkg/molten/bookmarks). The windows write them; this file moves the per-project bookmarks an earlier version kept in
// each workspace's meta, and drops the places of a project, a workspace or a context that is gone. Every write reads and
// writes the client inside one transaction, which wstore serialises (one connection), so two writers never overwrite
// each other.

const bookmarksMigrationTimeout = 30 * time.Second

type bookmarksEdit func(bookmarks.Store) (bookmarks.Store, bool)

func clientExists(ctx context.Context) bool {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	return err == nil && client != nil
}

// setClientBookmarks writes a store into the meta of a client the caller holds (the key goes when nothing is left); the
// caller saves the client.
func setClientBookmarks(client *waveobj.Client, store bookmarks.Store) {
	if value := store.MetaValue(); value != nil {
		if client.Meta == nil {
			client.Meta = make(waveobj.MetaMapType)
		}
		client.Meta[molten.BookmarksMetaKey] = value
		return
	}
	delete(client.Meta, molten.BookmarksMetaKey)
}

// editClientBookmarks applies an edit to the bookmarks of a client the caller holds and tells whether it changed them;
// the caller saves the client.
func editClientBookmarks(client *waveobj.Client, edit bookmarksEdit) bool {
	next, changed := edit(bookmarks.ReadStore(client.Meta))
	if !changed {
		return false
	}
	setClientBookmarks(client, next)
	return true
}

// editBookmarksInTx applies an edit to the client's bookmarks inside the caller's transaction and returns the client's
// id when it saved one. The client must exist: a read that fails inside a transaction fails the whole transaction, so
// the caller checks first (clientExists).
func editBookmarksInTx(tctx context.Context, edit bookmarksEdit) (string, error) {
	client, err := wstore.DBGetSingleton[*waveobj.Client](tctx)
	if err != nil {
		return "", fmt.Errorf("reading the client: %w", err)
	}
	if client == nil || !editClientBookmarks(client, edit) {
		return "", nil
	}
	return client.OID, wstore.DBUpdate(tctx, client)
}

// editBookmarks is editBookmarksInTx in a transaction of its own, for a caller that is not in one; the windows are told
// when the client changed. A failure is logged: what it was for (a place left behind, a place not put back) never
// blocks the deletion or the undo it follows.
func editBookmarks(ctx context.Context, what string, edit bookmarksEdit) {
	if !clientExists(ctx) {
		return
	}
	clientId := ""
	err := wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
		id, err := editBookmarksInTx(tx.Context(), edit)
		clientId = id
		return err
	})
	if err != nil {
		log.Printf("molten: %s: %v\n", what, err)
		return
	}
	if clientId != "" {
		SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Client, clientId))
	}
}

func contextIdsRemoved(before []contexts.Context, after []contexts.Context) []string {
	kept := make(map[string]bool, len(after))
	for _, c := range after {
		kept[c.Id] = true
	}
	var rtn []string
	for _, c := range before {
		if !kept[c.Id] {
			rtn = append(rtn, c.Id)
		}
	}
	return rtn
}

// forgetContextBookmarks drops the places of the contexts a change removed, on the client ApplyContexts is about to save.
func forgetContextBookmarks(client *waveobj.Client, before []contexts.Context, after []contexts.Context) {
	for _, id := range contextIdsRemoved(before, after) {
		editClientBookmarks(client, func(s bookmarks.Store) (bookmarks.Store, bool) { return bookmarks.WithoutContext(s, id) })
	}
}

// moltenForgetWorkspaceBookmarks drops the places of a workspace that was deleted, and of its projects.
func moltenForgetWorkspaceBookmarks(ctx context.Context, workspaceId string) {
	editBookmarks(ctx, "dropping the bookmarks of the deleted workspace "+workspaceId, func(s bookmarks.Store) (bookmarks.Store, bool) {
		return bookmarks.WithoutWorkspace(s, workspaceId)
	})
}

// moltenRestoreWorkspaceBookmarks puts back the places a deleted workspace had, when its deletion is undone.
func moltenRestoreWorkspaceBookmarks(ctx context.Context, part bookmarks.Store) {
	if len(part.Records) == 0 && len(part.Folders) == 0 {
		return
	}
	editBookmarks(ctx, "putting back the bookmarks of a restored workspace", func(s bookmarks.Store) (bookmarks.Store, bool) {
		return bookmarks.Restore(s, part), true
	})
}

// moltenWorkspaceBookmarksPart is what undo keeps of a workspace's bookmarks.
func moltenWorkspaceBookmarksPart(ctx context.Context, workspaceId string) bookmarks.Store {
	client, err := wstore.DBGetSingleton[*waveobj.Client](ctx)
	if err != nil || client == nil {
		return bookmarks.Store{}
	}
	return bookmarks.WorkspacePart(bookmarks.ReadStore(client.Meta), workspaceId)
}

// MigrateBookmarks moves the bookmarks each workspace kept per project into the client's bookmarks, once: the store and
// the deletion of every workspace's old key are written in one transaction, so a later start finds nothing to move and
// a failure leaves the old keys in place for the next start.
func MigrateBookmarks(ctx context.Context) error {
	if !clientExists(ctx) {
		return nil
	}
	return withContextsLock(func() error {
		return wstore.WithTx(ctx, func(tx *wstore.TxWrap) error {
			tctx := tx.Context()
			client, err := wstore.DBGetSingleton[*waveobj.Client](tctx)
			if err != nil {
				return fmt.Errorf("reading the client: %w", err)
			}
			all, err := wstore.DBGetAllObjsByType[*waveobj.Workspace](tctx, waveobj.OType_Workspace)
			if err != nil {
				return fmt.Errorf("reading the workspaces: %w", err)
			}
			byId := make(map[string]*waveobj.Workspace, len(all))
			metas := make([]bookmarks.WorkspaceMeta, 0, len(all))
			for _, ws := range all {
				byId[ws.OID] = ws
				metas = append(metas, bookmarks.WorkspaceMeta{Id: ws.OID, Meta: ws.Meta})
			}
			next, cleared := bookmarks.Migrate(bookmarks.ReadStore(client.Meta), metas)
			if len(cleared) == 0 {
				return nil
			}
			setClientBookmarks(client, next)
			if err := wstore.DBUpdate(tctx, client); err != nil {
				return fmt.Errorf("writing the bookmarks: %w", err)
			}
			for _, id := range cleared {
				ws := byId[id]
				delete(ws.Meta, molten.BookmarksLegacyMetaKey)
				if err := wstore.DBUpdate(tctx, ws); err != nil {
					return fmt.Errorf("clearing the old bookmarks of workspace %s: %w", id, err)
				}
			}
			log.Printf("molten: the bookmarks of %d workspace(s) moved to places\n", len(cleared))
			return nil
		})
	})
}

// MigrateLegacyBookmarks runs MigrateBookmarks at start, before any window loads a workspace; idempotent.
func MigrateLegacyBookmarks() error {
	defer func() {
		panichandler.PanicHandler("MigrateLegacyBookmarks", recover())
	}()
	ctx, cancel := context.WithTimeout(context.Background(), bookmarksMigrationTimeout)
	defer cancel()
	return MigrateBookmarks(ctx)
}
