# Ford Energy SiteNav Command — PGS v10 Alpha

Pedestrian Guidance System web app with the proven v9 2D routing experience and an optional v10 3D digital-twin preview.

## Local v10 preview

1. Generate the DTTK PGS package with the mobile geometry profile.
2. Copy the approved `site_mobile.glb` to `assets/models/site_mobile.glb`.
3. Double-click `run_pgs_v10.bat` (or run `py -m http.server 8765` from the repository root).
4. Use the browser page opened at `http://127.0.0.1:8765/` and select **3D Twin**. Do not open `index.html` directly as a local file.

When a route is generated, the 3D twin displays the current preview as a blue path with start, destination, and animated tracking markers. The route can be hidden or paused from the 3D Layers panel. This is a visual preview based on locally reviewed destination anchors; it is not yet a certified pedestrian path.

The 3D Layers panel can also display floor-aware room, corridor, amenity, stair, and elevator labels from the local DTTK `spatial_labels.json` handoff. These labels remain review-only until site approval.

The site-authored ground-floor spine and its major indoor hallway arms are
stored in `data/authored/pedestrian_network_base.json`. PGS loads this as the
default pedestrian walking-path layer when the browser does not already have a
newer local editing draft. It is infrastructure used by later routing; it is
not itself a predefined start-to-destination route.

Destination choices are grouped by visitor/check-in, entrances/security, production, amenities, and emergency use. Internal junctions and corridor waypoints are no longer presented as end-user destinations.

Use **Start Route Edit** after positioning the 3D camera to trace approved
hallway and sidewalk centerlines. Click the model at each turn or intersection.
The selected node is yellow and becomes the origin of the next edge.

- **New Segment** ends the current chain; the next model click starts an
  independent segment without drawing a line across rooms.
- Click an existing numbered node to select it, then click along another
  hallway to create a branch from that junction.
- **Delete Selected** removes a mistaken node and its incident edges.
- **Import JSON** loads a prior editor export so the campus network can be
  expanded across multiple sessions.
- **Undo** restores the graph before the last edit.

Every route-editor change is auto-saved in the current browser. Use **Export
JSON** to create the durable `pedestrian_network_draft_YYYY-MM-DD.json` file for
review and compilation. Draft paths are never treated as approved routes
automatically.

The **Map Label Editor** creates reversible spatial annotations without editing
the recovered Unity/XEUS source data. Choose an existing building or key-area
label to rename/reposition it, or choose **New label**, enter a name and type,
then click **Place / Move Label** and click the exact model feature. Label drafts
are auto-saved locally after every placement, move, import, or removal and can
be imported/exported as
`label_overrides_draft_YYYY-MM-DD.json`. A newly authored entrance label is not
automatically a routing destination; destination publication follows spatial
and pedestrian-network review.

Approximate straight-line 3D routes are intentionally hidden while the local DTTK handoff reports `route_certified: false`. The authored network must be reviewed and compiled before PGS will present a 3D route as approved.

The model and generated spatial JSON are excluded from Git because this repository is public. The existing 2D map remains the default and continues to provide the authoritative routing experience during the v10 alpha.

## Upload

1. Extract this ZIP.
2. Open your GitHub repository.
3. Click **Add file → Upload files**.
4. Drag all extracted files and folders into GitHub.
5. Click **Commit changes**.
6. Wait for GitHub Pages to redeploy.
7. Refresh your live site with **Ctrl + F5**.

## v9.0 Updates

- Rebuilt UI as a command-center style app.
- Final PGS app icon and PWA manifest included.
- Larger waypoint markers.
- Cleaner waypoint labels with white halo.
- Restored proper Legend panel.
- Added Layers panel with category toggles.
- Visitor, Employee, Contractor, and Emergency modes.
- Search with destination suggestions.
- Quick routes.
- Route summary and turn-by-turn steps.
- Pan, zoom, reset, and fit route.
- Mobile responsive layout.

## Important

Do not publish facility geometry, confidential security overlays, camera locations, badge reader data, or restricted-area details on a public GitHub Pages site. Use an approved access-controlled model host for deployment.
