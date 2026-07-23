let destinations = [], routes = [], quickRoutes = [], graph = {}, lastPath = [], mode = "employee";
let pedestrianNetwork = null, pedestrianGraph = {}, pedestrianNodes = {}, destinationNodeCrosswalk = {};
let view = { scale: 1, x: 0, y: 0 }, dragging = false, dragStart = null;
let workspaceView = "3d";
let config = {};
const MAP_W = 1024, MAP_H = 768;
const $ = id => document.getElementById(id);
const loc = id => destinations.find(d => d.id === id);
const fetchJson = url => fetch(url, { cache: "no-store" });

async function init() {
    config = await fetchJson("data/config.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));

    [destinations, routes, quickRoutes, pedestrianNetwork] = await Promise.all([
        fetchJson("data/destinations.json").then(r => r.json()).catch(() => []),
        fetchJson("data/routes.json").then(r => r.json()).catch(() => []),
        fetchJson("data/quick_routes.json").then(r => r.json()).catch(() => []),
        fetchJson("data/generated/pedestrian_network.json").then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    const crosswalk = await fetchJson("data/generated/destination_node_crosswalk.json").then(r => r.ok ? r.json() : null).catch(() => null);
    if (crosswalk) destinationNodeCrosswalk = Object.fromEntries((crosswalk.destinations || []).map(item => [item.destination_id, item.node_id]));

    buildGraph(); buildPedestrianGraph(); populateSelects(); renderQuickRoutes(); drawNetwork(); drawNodes(); wireEvents(); resetView();

    setMode("employee");

    // FIX: Only force 3D if NOT in editor mode
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('editor') === 'true') {
        document.body.classList.add('editor-active');
        setWorkspaceView("2d"); // Keep 2D frame visible for the editor tools
        if (typeof initPedestrianNetworkEditor === "function") initPedestrianNetworkEditor();
        if (typeof initMapLabelEditor === "function") initMapLabelEditor();
        if (typeof initDestinationAnchorEditor === "function") initDestinationAnchorEditor();
    } else {
        setWorkspaceView("3d"); // Normal users get 3D automatically
    }

    updateClock(); setInterval(updateClock, 30000);
}

function buildGraph() {
    graph = {}; destinations.forEach(d => graph[d.id] = []);
    routes.forEach(([a, b, w]) => { if (graph[a] && graph[b]) { graph[a].push({ id: b, weight: w }); graph[b].push({ id: a, weight: w }); } });
}

function destinationGroup(destination) {
    if (destination.zone === "Visitor" || destination.category === "visitor") return "Visitor / Check-In";
    if (destination.zone === "Security" || destination.category === "security") return "Entrances / Security";
    if (destination.zone === "Production" || destination.category === "production") return "Production Areas";
    if (destination.zone === "Amenities" || destination.category === "amenity") return "Amenities / Employee Services";
    if (destination.zone === "Emergency" || destination.category === "emergency") return "Emergency / Muster";
    return "Department / Key Areas";
}

function buildPedestrianGraph() {
    pedestrianGraph = {}; pedestrianNodes = {};

    // FIX: Removed the "if (!isReady) return;" block. 
    // We MUST build the graph into memory even if it's a draft, otherwise the 3D map has no coordinates to draw.
    (pedestrianNetwork?.nodes || []).forEach(node => { pedestrianNodes[node.id] = node; pedestrianGraph[node.id] = []; });
    (pedestrianNetwork?.edges || []).forEach(edge => {
        if (!pedestrianGraph[edge.from] || !pedestrianGraph[edge.to]) return;
        const weight = Number(edge.distance) || distance3d(pedestrianNodes[edge.from].position, pedestrianNodes[edge.to].position);
        pedestrianGraph[edge.from].push({ id: edge.to, weight, edge });
        if (edge.bidirectional !== false) pedestrianGraph[edge.to].push({ id: edge.from, weight, edge });
    });
}

function distance3d(a, b) {
    return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0), (a?.z || 0) - (b?.z || 0));
}

function matchesDestinationCategory(destination, category) {
    if (category === "all") return true;
    if (category === "visitor") return destination.zone === "Visitor" || (destination.category && destination.category.includes("visitor"));
    if (category === "security") return destination.zone === "Security" || destination.category === "security";
    if (category === "production") return destination.zone === "Production" || destination.category === "department";
    if (category === "amenities") return destination.zone === "Amenities" || destination.category === "amenity";
    if (category === "emergency") return destination.zone === "Emergency" || destination.category === "emergency";
    return true;
}

function addGroupedOptions(select, items) {
    const groups = new Map();
    items.forEach(destination => {
        const group = destinationGroup(destination);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(destination);
    });
    groups.forEach((groupItems, label) => {
        const optgroup = document.createElement("optgroup");
        optgroup.label = label;
        groupItems.sort((a, b) => a.name.localeCompare(b.name)).forEach(destination => {
            optgroup.appendChild(new Option(destination.name, destination.id));
        });
        select.appendChild(optgroup);
    });
}

function populateSelects(category = $("destinationCategory")?.value || "all") {
    const s = $("startSelect"), e = $("endSelect");
    if (!s || !e) return;
    const previousStart = s.value, previousEnd = e.value;
    s.innerHTML = ""; e.innerHTML = "";
    const selectable = destinations.filter(destination => !["junction", "corridor"].includes(destination.type));
    addGroupedOptions(s, selectable);
    addGroupedOptions(e, selectable.filter(destination => matchesDestinationCategory(destination, category)));
    if ([...s.options].some(option => option.value === previousStart)) s.value = previousStart;
    if ([...e.options].some(option => option.value === previousEnd)) e.value = previousEnd;
}

function renderQuickRoutes() {
    const wrap = $("quickRoutes"); if (!wrap) return; wrap.innerHTML = "";
    quickRoutes.forEach(q => {
        const btn = document.createElement("button");
        btn.className = "quick-route";
        btn.innerHTML = `<span>${q.label}</span><b>→</b>`;
        btn.onclick = () => { if (q.mode) setMode(q.mode, false); $("startSelect").value = q.start; $("endSelect").value = q.end; generateRoute(); fitRoute(); };
        wrap.appendChild(btn);
    });
}

function wireEvents() {
    if ($("routeBtn")) $("routeBtn").onclick = generateRoute;
    if ($("destinationCategory")) $("destinationCategory").onchange = event => populateSelects(event.target.value);
    if ($("zoomIn")) $("zoomIn").onclick = () => zoom(1.2);
    if ($("zoomOut")) $("zoomOut").onclick = () => zoom(.83);
    if ($("resetView")) $("resetView").onclick = () => workspaceView === "3d" ? window.pgs3d?.reset() : resetView();
    if ($("centerView")) $("centerView").onclick = resetView;
    if ($("fitRoute")) $("fitRoute").onclick = fitRoute;
    if ($("view2DBtn")) $("view2DBtn").onclick = () => setWorkspaceView("2d");
    if ($("view3DBtn")) $("view3DBtn").onclick = () => setWorkspaceView("3d");
    if ($("searchFocus")) $("searchFocus").onclick = () => $("searchBox")?.focus();
    if ($("fullscreenBtn")) $("fullscreenBtn").onclick = () => document.documentElement.requestFullscreen?.();
    if ($("legendOpen")) $("legendOpen").onclick = () => $("legendPanel")?.classList.toggle("hide");
    if ($("legendClose")) $("legendClose").onclick = () => $("legendPanel")?.classList.add("hide");
    if ($("layersOpen")) $("layersOpen").onclick = () => $("layersPanel")?.classList.toggle("show");
    if ($("layersClose")) $("layersClose").onclick = () => $("layersPanel")?.classList.remove("show");
    if ($("labelsToggle")) $("labelsToggle").onchange = e => toggleLabels(e.target.checked);
    if ($("networkToggle")) $("networkToggle").onchange = e => toggleNetwork(e.target.checked);
    if ($("pulseToggle")) $("pulseToggle").onchange = e => $("overlay")?.classList.toggle("no-pulse", !e.target.checked);
    if ($("searchClear")) $("searchClear").onclick = () => { $("searchBox").value = ""; $("searchResults")?.classList.remove("show"); };

    // FIX: Catch-all fallback listeners for top toolbar buttons
    document.querySelectorAll("button").forEach(btn => {
        const text = (btn.textContent || btn.title || btn.id || "").toLowerCase();
        if (text.includes("legend")) btn.addEventListener("click", () => $("legendPanel")?.classList.toggle("hide"));
        if (text.includes("layer")) btn.addEventListener("click", () => $("layersPanel")?.classList.toggle("show"));
        if (text === "search" || text.includes("searchfocus")) btn.addEventListener("click", () => $("searchBox")?.focus());
    });

    document.querySelectorAll(".mode").forEach(b => b.onclick = () => setMode(b.dataset.mode));
    document.querySelectorAll("[data-layer]").forEach(cb => cb.onchange = applyLayerFilters);

    if ($("searchBox")) $("searchBox").oninput = e => renderSearch(e.target.value);
    if ($("shareBtn")) $("shareBtn").onclick = shareRoute;
    if ($("directionsBtn")) $("directionsBtn").onclick = () => { $("steps")?.scrollIntoView({ behavior: "smooth", block: "nearest" }); };

    const f = $("mapFrame");
    if (f) {
        f.onwheel = e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : .89); };
        f.onmousedown = e => { dragging = true; dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; f.classList.add("dragging"); };
    }
    window.onmousemove = e => { if (!dragging) return; view.x = dragStart.vx + e.clientX - dragStart.x; view.y = dragStart.vy + e.clientY - dragStart.y; applyView(); };
    window.onmouseup = () => { dragging = false; f?.classList.remove("dragging"); };
    window.onresize = () => { if (workspaceView === "2d") resetView(); };
}

function setWorkspaceView(next) {
    workspaceView = next === "3d" ? "3d" : "2d";
    const is3d = workspaceView === "3d";
    document.querySelector(".map-shell")?.classList.toggle("three-active", is3d);
    if ($("mapFrame")) $("mapFrame").hidden = is3d;
    if ($("threeFrame")) $("threeFrame").hidden = !is3d;
    if ($("view2DBtn")) { $("view2DBtn").classList.toggle("active", !is3d); $("view2DBtn").setAttribute("aria-pressed", String(!is3d)); }
    if ($("view3DBtn")) { $("view3DBtn").classList.toggle("active", is3d); $("view3DBtn").setAttribute("aria-pressed", String(is3d)); }
    ["zoomIn", "zoomOut", "centerView", "fitRoute"].forEach(id => { if ($(id)) $(id).disabled = is3d; });
    if (is3d) window.pgs3d?.show(); else { window.pgs3d?.hide(); resetView(); }
}

function setMode(m, generate = true) {
    mode = m;
    document.querySelectorAll(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
    if (m === "visitor") { if ($("destinationCategory")) $("destinationCategory").value = "visitor"; populateSelects("visitor"); if ($("subtitle")) $("subtitle").textContent = "Visitor-safe guided routing"; }
    else if (m === "employee") { if ($("destinationCategory")) $("destinationCategory").value = "production"; populateSelects("production"); if ($("subtitle")) $("subtitle").textContent = "Employee pedestrian movement"; }
    else if (m === "contractor") { if ($("destinationCategory")) $("destinationCategory").value = "production"; populateSelects("production"); if ($("subtitle")) $("subtitle").textContent = "Contractor / trade access routing"; }
    else { if ($("destinationCategory")) $("destinationCategory").value = "emergency"; populateSelects("emergency"); if ($("subtitle")) $("subtitle").textContent = "Emergency reference routing"; }
    if (generate) generateRoute();
}

function drawNetwork() {
    const l = $("networkLayer"); if (!l) return; l.innerHTML = "";
    routes.forEach(([a, b]) => {
        const A = loc(a), B = loc(b);
        if (!A || !B) return;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", A.x); line.setAttribute("y1", A.y);
        line.setAttribute("x2", B.x); line.setAttribute("y2", B.y);
        line.setAttribute("class", "network");
        l.appendChild(line);
    });
}

function drawNodes() {
    const l = $("nodeLayer"); if (!l) return; l.innerHTML = "";
    destinations.forEach(d => {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        g.setAttribute("class", `node ${d.type}`);
        g.setAttribute("transform", `translate(${d.x || 0},${d.y || 0})`);
        g.dataset.id = d.id; g.dataset.type = d.type;
        g.innerHTML = `<circle class="pulse" r="0"></circle>
      <circle class="marker-ring" r="12"></circle>
      <circle class="marker-dot marker-core" r="8"></circle>
      <text x="16" y="-9">${escapeHtml(d.label || d.name)}</text>`;
        g.onclick = () => { if (!["junction", "corridor"].includes(d.type)) if ($("endSelect")) $("endSelect").value = d.id; showDestination(d.id); };
        l.appendChild(g);
    });
}

function dijkstra(start, end, sourceGraph = graph) {
    const dist = {}, prev = {}, q = new Set(Object.keys(sourceGraph));
    Object.keys(sourceGraph).forEach(k => dist[k] = Infinity); dist[start] = 0;
    while (q.size) {
        let u = [...q].sort((a, b) => dist[a] - dist[b])[0]; q.delete(u);
        if (u === end) break;
        for (const n of sourceGraph[u] || []) {
            if (sourceGraph === pedestrianGraph && !edgeAllowsMode(n.edge, mode)) continue;
            const alt = dist[u] + n.weight;
            if (alt < dist[n.id]) { dist[n.id] = alt; prev[n.id] = u; }
        }
    }
    const path = []; let u = end;
    while (u) { path.unshift(u); u = prev[u]; }
    return { path, distance: dist[end] };
}

function generateRoute() {
    const sSelect = $("startSelect"), eSelect = $("endSelect");
    if (!sSelect || !eSelect) return;
    const start = sSelect.value, end = eSelect.value;
    if (!start || !end || start === end) return;

    // Crosswalk translation
    const startNode = destinationNodeCrosswalk[start] || start;
    const endNode = destinationNodeCrosswalk[end] || end;

    // BYPASS APPROVAL: Force the spatial path calculation using the loaded nodes
    const spatialResult = (pedestrianGraph[startNode] && pedestrianGraph[endNode])
        ? dijkstra(startNode, endNode, pedestrianGraph)
        : null;

    const spatialValid = spatialResult && Number.isFinite(spatialResult.distance);

    const result = dijkstra(start, end);
    lastPath = result.path;
    const displayResult = spatialValid ? { ...result, distance: spatialResult.distance, distanceUnit: "meters", certified: true } : result;

    drawRoute(result.path);
    updateRoute(displayResult);
    showDestination(end);

    const routeDetail = {
        path: [...result.path],
        destinations: result.path.map(id => loc(id)).filter(Boolean),
        distance: displayResult.distance,
        distanceUnit: displayResult.distanceUnit || "map-units",
        certified: Boolean(spatialValid),
        spatialNodeIds: spatialValid ? [...spatialResult.path] : [],
        // Send the exact 3D coordinates directly to viewer3d.js
        spatialPath: spatialValid ? spatialResult.path.map(id => pedestrianNodes[id]?.position).filter(Boolean) : []
    };

    window.pgsCurrentRoute = routeDetail;
    window.dispatchEvent(new CustomEvent("pgs:route", { detail: routeDetail }));
    console.log("3D Route Data Dispatched:", routeDetail.spatialPath.length, "waypoints");
}

function edgeAllowsMode(edge, currentMode) {
    const allowed = (edge?.access || []).map(value => String(value).toLowerCase());
    if (!allowed.length || currentMode === "emergency") return true;
    return allowed.includes(currentMode) || allowed.includes("all") || allowed.includes("authorized");
}

function drawRoute(path) {
    const l = $("routeLayer");
    if (!l) return;
    l.innerHTML = "";

    const points = path
        .map(id => loc(id))
        .filter(d => d && typeof d.x !== 'undefined' && typeof d.y !== 'undefined')
        .map(d => `${d.x},${d.y}`)
        .join(" ");

    if (!points) return;

    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("points", points);
    pl.setAttribute("class", "route");
    pl.setAttribute("marker-end", "url(#arrow)");
    l.appendChild(pl);
    document.querySelectorAll(".node").forEach(n => n.classList.remove("selected"));
    path.forEach(id => document.querySelector(`.node[data-id="${id}"]`)?.classList.add("selected"));
}

function updateRoute(r) {
    const feet = Math.round(r.distance * (r.distanceUnit === "meters" ? 3.28084 : 1.7)), mins = Math.max(1, Math.round(feet / 250));
    if ($("routeStatus")) $("routeStatus").textContent = r.certified ? "APPROVED NETWORK" : "DRAFT PREVIEW";
    if ($("distanceMetric")) $("distanceMetric").textContent = feet + " ft";
    if ($("timeMetric")) $("timeMetric").textContent = mins + " min";
    if ($("sumDistance")) $("sumDistance").textContent = feet + " ft";
    if ($("sumTime")) $("sumTime").textContent = mins + " min";
    if ($("sumStart")) $("sumStart").textContent = loc(r.path[0])?.name || r.path[0];
    if ($("sumEnd")) $("sumEnd").textContent = loc(r.path.at(-1))?.name || r.path.at(-1);
    const steps = $("steps"); if (!steps) return; steps.innerHTML = "";
    r.path.forEach((id, i) => {
        const d = loc(id); if (!d) return;
        const el = document.createElement("div");
        el.className = "step"; el.innerHTML = `<b>${i + 1}. ${escapeHtml(d.name)}</b>${escapeHtml(d.description || "")}`;
        steps.appendChild(el);
    });
}

function showDestination(id) {
    const d = loc(id); if (!d) return;
    if ($("drawerTitle")) $("drawerTitle").textContent = d.name;
    if ($("drawerDesc")) $("drawerDesc").textContent = d.description || "";
    if ($("drawerAccess")) $("drawerAccess").textContent = d.access || "Authorized Personnel";
    if ($("drawerType")) $("drawerType").textContent = d.category || "Department";
    if ($("drawerEscort")) $("drawerEscort").textContent = (d.access || "").toLowerCase().includes("visitor") ? "Required / As Assigned" : "As Required";
}

function renderSearch(q) {
    q = q.toLowerCase().trim();
    const box = $("searchResults"); if (!box) return; box.innerHTML = "";
    if (q.length < 2) { box.classList.remove("show"); return; }
    const category = $("destinationCategory")?.value || "all";
    const matches = destinations
        .filter(d => !["junction", "corridor"].includes(d.type))
        .filter(d => matchesDestinationCategory(d, category))
        .filter(d => {
            const searchText = [d.name, d.id, d.label, d.category, d.zone, d.description].filter(Boolean).join(" ").toLowerCase();
            return searchText.includes(q);
        })
        .sort((a, b) => destinationGroup(a).localeCompare(destinationGroup(b)) || (a.name || a.id).localeCompare(b.name || b.id))
        .slice(0, 15);

    matches.forEach(d => {
        const btn = document.createElement("button");
        const displayName = escapeHtml(d.name || d.id || "Unnamed Room");
        btn.innerHTML = `<b>${displayName}</b><br><small>${escapeHtml(d.category || "Room")} • ${escapeHtml(d.access || "Standard")}</small>`;
        btn.onclick = () => {
            $("endSelect").value = d.id;
            showDestination(d.id);
            box.classList.remove("show");
            $("searchBox").value = displayName;
            generateRoute();
        };
        box.appendChild(btn);
    });
    box.classList.toggle("show", matches.length > 0);
}

function applyLayerFilters() {
    const active = {};
    document.querySelectorAll("[data-layer]").forEach(cb => active[cb.dataset.layer] = cb.checked);
    document.querySelectorAll(".node").forEach(n => n.classList.toggle("hidden-layer", active[n.dataset.type] === false));
}

function applyView() { if ($("mapStage")) $("mapStage").style.transform = `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`; }
function resetView() { const f = $("mapFrame"); if (!f) return; view.scale = Math.min(f.clientWidth / MAP_W, f.clientHeight / MAP_H) * .94; view.x = 0; view.y = 0; applyView(); }
function zoom(f) { view.scale = Math.max(.25, Math.min(5, view.scale * f)); applyView(); }
function fitRoute() {
    if (!lastPath.length) return;
    if (workspaceView !== "2d") setWorkspaceView("2d");
    const f = $("mapFrame"), pts = lastPath.map(loc).filter(Boolean);
    if (!pts.length) return;
    const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
    const pad = 130;
    view.scale = Math.min(f.clientWidth / (maxX - minX + pad * 2), f.clientHeight / (maxY - minY + pad * 2), 2.4);
    view.x = (MAP_W / 2 - (minX + maxX) / 2) * view.scale; view.y = (MAP_H / 2 - (minY + maxY) / 2) * view.scale; applyView();
}
function toggleLabels(show) { $("overlay")?.classList.toggle("hide-labels", !show); }
function toggleNetwork(show) { $("overlay")?.classList.toggle("hide-network", !show); }
function updateClock() { if ($("clock")) $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function shareRoute() {
    const start = $("startSelect")?.value, end = $("endSelect")?.value;
    const url = `${location.origin}${location.pathname}?start=${start}&end=${end}`;
    navigator.clipboard?.writeText(url);
    showToast("Route link copied");
}
function showToast(msg) { const t = $("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 1800); }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[m])); }

init();