# Ford Energy SiteNav Command — PGS v10 Alpha

Pedestrian Guidance System web app with the proven v9 2D routing experience and an optional v10 3D digital-twin preview.

## Local v10 preview

1. Generate the DTTK PGS package with the mobile geometry profile.
2. Copy the approved `site_mobile.glb` to `assets/models/site_mobile.glb`.
3. Double-click `run_pgs_v10.bat` (or run `py -m http.server 8765` from the repository root).
4. Use the browser page opened at `http://127.0.0.1:8765/` and select **3D Twin**. Do not open `index.html` directly as a local file.

When a route is generated, the 3D twin displays the current preview as a blue path with start, destination, and animated tracking markers. The route can be hidden or paused from the 3D Layers panel. This is a visual preview based on locally reviewed destination anchors; it is not yet a certified pedestrian path.

The 3D Layers panel can also display floor-aware room, corridor, amenity, stair, and elevator labels from the local DTTK `spatial_labels.json` handoff. These labels remain review-only until site approval.

Use **Start Route Edit** after positioning the 3D camera to trace an approved hallway or sidewalk centerline. Click the model at each turn or intersection, then save the draft locally or export `pedestrian_network_draft_YYYY-MM-DD.json` for review. Draft paths are never treated as approved routes automatically.

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
