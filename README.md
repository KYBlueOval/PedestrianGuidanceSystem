# Ford Energy SiteNav Command

A free GitHub Pages visitor and pedestrian navigation web app using the provided In-Plant Pedestrian Access Routes PDF as the map background.

## What this is

This is a static web app. No server. No database. No paid indoor mapping platform.

It includes:

- Full-screen command-center style interface
- Pedestrian route overlay
- Clickable destinations
- Start/destination routing
- Visitor, Employee, and Emergency modes
- Animated glowing route line
- JSON-driven locations and routes
- GitHub Pages ready

## File structure

```text
ford-energy-sitenav-command/
├─ index.html
├─ style.css
├─ app.js
├─ assets/
│  └─ plant-access-map.png
├─ data/
│  ├─ locations.json
│  └─ routes.json
└─ docs/
   └─ SETUP-GITHUB-PAGES.md
```

## Quick local test

Open `index.html` in Chrome or Edge.

If browser blocks local JSON loading, run this from the folder:

```powershell
python -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## Edit destinations

Open:

```text
data/locations.json
```

Each location uses the map coordinate system:

```json
{
  "id": "main_guard_house",
  "name": "Plant Entry - Main Guard House",
  "type": "entry",
  "category": "Visitor / Security",
  "x": 510,
  "y": 162,
  "access": "Visitor + Employee",
  "description": "Primary visitor and plant personnel entry point."
}
```

Change the `x` and `y` values to move points around the map.

## Edit routes

Open:

```text
data/routes.json
```

Each route segment is:

```json
["main_guard_house", "visitor_badging", 95]
```

Format:

```text
[start_location_id, end_location_id, route_weight]
```

Lower weight = preferred route.
Higher weight = longer or less preferred.

## Recommended workflow

1. Upload this folder to a new GitHub repository.
2. Enable GitHub Pages.
3. Test the public URL.
4. Adjust destination points in `data/locations.json`.
5. Adjust route segments in `data/routes.json`.
6. Add QR codes at guardhouses that link to the GitHub Pages URL.

## Important

Do not publish sensitive security layers, camera locations, access-control devices, or restricted-area details on a public GitHub Pages site. Use a private/internal host if this is production.
