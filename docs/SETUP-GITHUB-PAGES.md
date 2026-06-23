# GitHub Pages Setup

## Step 1 - Create GitHub repo

1. Go to GitHub.
2. Click **New repository**.
3. Name it:

```text
ford-energy-sitenav-command
```

4. Set visibility:
   - Public for demo only
   - Private/internal for real plant use

5. Click **Create repository**.

## Step 2 - Upload files

Upload everything inside this folder:

```text
index.html
style.css
app.js
assets/
data/
docs/
README.md
```

Do not upload the parent zip only. Upload the extracted files.

## Step 3 - Enable Pages

1. Go to repo **Settings**.
2. Click **Pages**.
3. Source: **Deploy from a branch**.
4. Branch: **main**.
5. Folder: **/root**.
6. Save.

GitHub will give you a URL like:

```text
https://YOUR-USERNAME.github.io/ford-energy-sitenav-command/
```

## Step 4 - Test

Open the URL on:

- Desktop browser
- Phone
- Tablet
- Guardhouse kiosk screen

## Step 5 - Customize the map

Edit:

```text
data/locations.json
```

Move any node by changing:

```json
"x": 510,
"y": 162
```

## Step 6 - Customize routing

Edit:

```text
data/routes.json
```

Add a new route segment like:

```json
["main_guard_house", "visitor_badging", 95]
```

## Step 7 - Make QR codes

Make QR codes for:

- Main Guard House
- Sub Guard House
- Module Guard House
- Visitor Parking
- Training Center

For simple QR signs, use the base GitHub Pages URL.

For a better future version, add URL parameters like:

```text
?start=main_guard_house&end=training_center
```

## Step 8 - Production security note

For real deployment, do not expose sensitive security information publicly.

Recommended production options:

- Internal SharePoint page
- Internal IIS web server
- Private GitHub Enterprise Pages
- Azure Static Web Apps behind Entra ID
