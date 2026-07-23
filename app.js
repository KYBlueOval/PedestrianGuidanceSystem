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
    console.log("Initializing PGS v10...");
    config = await fetchJson("data/config.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('editor') === 'true') {
        document.body.classList.add('editor-active');
        if (typeof initPedestrianNetworkEditor === "function") initPedestrianNetworkEditor();
        if (typeof initMapLabelEditor === "function") initMapLabelEditor();
        if (typeof initDestinationAnchorEditor === "function") initDestinationAnchorEditor();
    }

    try {
        const [dest, rout, quick, net] = await Promise.all([
            fetchJson("data/destinations.json").then(r => r.json()),
            fetchJson("data/routes.json").then(r => r.json()),
            fetchJson("data/quick_routes.json").then(r => r.json()),
            fetchJson("data/generated/pedestrian_network.json").then(r => r.ok ? r.json() : null)
        ]);
        destinations = dest; routes = rout; quickRoutes = quick; pedestrianNetwork = net;
        console.log("Network Data Loaded:", !!pedestrianNetwork);
    } catch (e) {
        console.error("Critical Data Load Error:", e);
    }

    const crosswalk = await fetchJson("data/generated/destination_node_crosswalk.json").then(r => r.ok ? r.json() : null).catch(() => null);
    if (crosswalk) destinationNodeCrosswalk = Object.fromEntries((crosswalk.destinations || []).map(item => [item.destination_id, item.node_id]));

    buildGraph(); buildPedestrianGraph(); populateSelects(); renderQuickRoutes(); drawNetwork(); drawNodes(); wireEvents(); resetView();

    // Default to employee mode on load
    setMode("employee");

    // EXPLICITLY BOOT THE 3D ENGINE
    setWorkspaceView("3d");

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
    const isReady = pedestrianNetwork?.review?.route_ready === true || pedestrianNetwork?.approved === true || pedestrianNetwork?.review_status === "approved";
    if (!isReady) { console.warn("Pedestrian network not ready or approved."); return; }
    (pedestrianNetwork.nodes || []).forEach(node => { pedestrianNodes[node.id] = node; pedestrianGraph[node.id] = []; });
    (pedestrianNetwork.edges || []).forEach(edge => {
        if (!pedestrianGraph[edge.from] || !pedestrianGraph[edge.to]) return;
        const weight = Number(edge.distance) || distance3d(pedestrianNodes[edge.from].position, pedestrianNodes[edge.to].position);
        pedestrianGraph[edge.from].push({ id: edge.to, weight, edge });
        if (edge.bidirectional !== false) pedestrianGraph[edge.to].push({ id: edge.from, weight, edge });
    });
}

function distance3d(a, b) { return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0), (a?.z || 0) - (b?.z || 0)); }

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

    if ($("resetView")) $("resetView").onclick = () => workspaceView === "3d" ? window.pgs3d?.reset() : resetView();
    if ($("fitRoute")) $("fitRoute").onclick = fitRoute;
    if ($("searchFocus")) $("searchFocus").onclick = () => $("searchBox")?.focus();
    if ($("fullscreenBtn")) $("fullscreenBtn").onclick = () => document.documentElement.requestFullscreen?.();
    if ($("searchClear")) $("searchClear").onclick = () => { $("searchBox").value = ""; $("searchResults")?.classList.remove("show"); };

    document.querySelectorAll(".mode").forEach(b => b.onclick = () => setMode(b.dataset.mode));
    document.querySelectorAll("[data-layer]").forEach(cb => cb.onchange = applyLayerFilters);

    if ($("searchBox")) $("searchBox").oninput = e => renderSearch(e.target.value);

    const f = $("mapFrame");
    if (f) {
        f.onwheel = e => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : .89); };
        f.onmousedown = e => { dragging = true; dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; f.classList.add("dragging"); };
    }
    window.onmousemove = e => { if (!dragging) return; view.x = dragStart.vx + e.clientX - dragStart.x; view.y = dragStart.vy + e.clientY - dragStart.y; applyView(); };
    window.onmouseup = () => { dragging = false; f?.classList.remove("dragging"); };
}

function setWorkspaceView(next) {
    workspaceView = next === "3d" ? "3d" : "2d";
    const is3d = workspaceView === "3d";
    document.querySelector(".map-shell")?.classList.toggle("three-active", is3d);
    if (is3d) window.pgs3d?.show(); else { window.pgs3d?.hide(); resetView(); }
}

function setMode(m, generate = true) {
    mode = m;
    document.querySelectorAll(".mode").forEach(b => b.classList.toggle("active", b.dataset.mode === m));
    if (m === "visitor") { if ($("destinationCategory")) $("destinationCategory").value = "visitor"; populateSelects("visitor"); }
    else if (m === "employee") { if ($("destinationCategory")) $("destinationCategory").value = "production"; populateSelects("production"); }
    else if (m === "contractor") { if ($("destinationCategory")) $("destinationCategory").value = "production"; populateSelects("production"); }
    else { if ($("destinationCategory")) $("destinationCategory").value = "emergency"; populateSelects("emergency"); }
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
        g.innerHTML = `<circle class="pulse" r="0"></circle><circle class="marker-ring" r="12"></circle><circle class="marker-dot marker-core" r="8"></circle><text x="16" y="-9">${escapeHtml(d.name || d.id)}</text>`;
        l.appendChild(g);
    });
}

function drawRoute(path) {
    const l = $("routeLayer");
    if (!l) return;
    l.innerHTML = "";
    const points = path.map(id => loc(id)).filter(d => d && typeof d.x !== 'undefined').map(d => `${d.x},${d.y}`).join(" ");
    if (!points) return;
    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("points", points); pl.setAttribute("class", "route");
    l.appendChild(pl);
}

function generateRoute() {
    const start = $("startSelect")?.value, end = $("endSelect")?.value;
    if (!start || !end || start === end) return;
    const result = dijkstra(start, end);
    lastPath = result.path;
    drawRoute(result.path);
    console.log("Route Generated for:", start, "to", end);
}

function dijkstra(start, end, sourceGraph = graph) {
    const dist = {}, prev = {}, q = new Set(Object.keys(sourceGraph));
    Object.keys(sourceGraph).forEach(k => dist[k] = Infinity); dist[start] = 0;
    while (q.size) {
        let u = [...q].sort((a, b) => dist[a] - dist[b])[0]; q.delete(u);
        if (u === end) break;
        for (const n of sourceGraph[u] || []) {
            const alt = dist[u] + n.weight;
            if (alt < dist[n.id]) { dist[n.id] = alt; prev[n.id] = u; }
        }
    }
    const path = []; let u = end;
    while (u) { path.unshift(u); u = prev[u]; }
    return { path, distance: dist[end] };
}

function updateClock() { if ($("clock")) $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function applyView() { if ($("mapStage")) $("mapStage").style.transform = `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`; }
function resetView() { const f = $("mapFrame"); if (!f) return; view.scale = Math.min(f.clientWidth / MAP_W, f.clientHeight / MAP_H) * .94; view.x = 0; view.y = 0; applyView(); }
function zoom(f) { view.scale = Math.max(.25, Math.min(5, view.scale * f)); applyView(); }
function fitRoute() { const f = $("mapFrame"); if (!f || !lastPath.length) return; const pts = lastPath.map(loc).filter(Boolean); const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x)), minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y)); view.scale = Math.min(f.clientWidth / (maxX - minX + 260), f.clientHeight / (maxY - minY + 260)); view.x = (MAP_W / 2 - (minX + maxX) / 2) * view.scale; view.y = (MAP_H / 2 - (minY + maxY) / 2) * view.scale; applyView(); }
function applyLayerFilters() { document.querySelectorAll("[data-layer]").forEach(cb => { document.querySelectorAll(`[data-3d-layer="${cb.dataset.layer}"]`).forEach(el => el.style.display = cb.checked ? "" : "none"); }); }

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[m])); }

function showDestination(id) {
    const d = loc(id); if (!d) return;
    if ($("drawerTitle")) $("drawerTitle").textContent = d.name;
    if ($("drawerDesc")) $("drawerDesc").textContent = d.description || "";
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
            // Broad search: checks name, id, label, category, zone, and description
            const searchString = [d.name, d.id, d.label, d.category, d.zone, d.description].filter(Boolean).join(" ").toLowerCase();
            return searchString.includes(q);
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

init();