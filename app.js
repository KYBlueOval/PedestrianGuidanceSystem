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
    // Service Worker & Cache Wipe
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => { for (let r of regs) r.unregister(); });
    }
    if ('caches' in window) {
        caches.keys().then(names => { for (let n of names) caches.delete(n); });
    }

    config = await fetchJson("data/config.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));

    [destinations, routes, quickRoutes, pedestrianNetwork] = await Promise.all([
        fetchJson("data/destinations.json").then(r => r.json()).catch(() => []),
        fetchJson("data/routes.json").then(r => r.json()).catch(() => []),
        fetchJson("data/quick_routes.json").then(r => r.json()).catch(() => []),
        fetchJson("data/generated/pedestrian_network.json").then(r => r.ok ? r.json() : null).catch(() => null)
    ]);

    const crosswalk = await fetchJson("data/generated/destination_node_crosswalk.json").then(r => r.ok ? r.json() : null).catch(() => null);
    if (crosswalk) {
        destinationNodeCrosswalk = Object.fromEntries(
            (crosswalk.destinations || []).map(item => [item.destination_id, item.node_id])
        );
    }

    buildGraph();
    buildPedestrianGraph();
    populateSelects();
    renderQuickRoutes();
    drawNetwork();
    drawNodes();
    injectSpatialSearchUI();
    wireEvents();
    resetView();

    setMode("employee");

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('editor') === 'true') {
        document.body.classList.add('editor-active');
        document.querySelectorAll('.editor-control, .editor-bar, #editorPanel, [data-editor-ui], .editor-ui, .editor-drawer, .editor-sidebar').forEach(el => {
            el.style.display = 'block';
            el.hidden = false;
        });

        if (typeof initPedestrianNetworkEditor === "function") initPedestrianNetworkEditor();
        if (typeof initMapLabelEditor === "function") initMapLabelEditor();
        if (typeof initDestinationAnchorEditor === "function") initDestinationAnchorEditor();
    }

    setWorkspaceView("3d");
    updateClock();
    setInterval(updateClock, 30000);
}

function buildGraph() {
    graph = {};
    destinations.forEach(d => graph[d.id] = []);
    routes.forEach(([a, b, w]) => {
        if (graph[a] && graph[b]) {
            graph[a].push({ id: b, weight: w });
            graph[b].push({ id: a, weight: w });
        }
    });
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
    pedestrianGraph = {};
    pedestrianNodes = {};
    (pedestrianNetwork?.nodes || []).forEach(node => {
        pedestrianNodes[node.id] = node;
        pedestrianGraph[node.id] = [];
    });
    (pedestrianNetwork?.edges || []).forEach(edge => {
        if (!pedestrianGraph[edge.from] || !pedestrianGraph[edge.to]) return;
        const posA = pedestrianNodes[edge.from]?.position;
        const posB = pedestrianNodes[edge.to]?.position;
        const weight = Number(edge.distance) || distance3d(posA, posB);
        pedestrianGraph[edge.from].push({ id: edge.to, weight, edge });
        if (edge.bidirectional !== false) {
            pedestrianGraph[edge.to].push({ id: edge.from, weight, edge });
        }
    });
}

function distance3d(a, b) {
    if (!a || !b) return 10;
    return Math.hypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0), (a.z || 0) - (b.z || 0));
}

// Find nearest node on the pedestrian network graph for any unmapped destination
function findNearestPedestrianNode(targetDestId) {
    if (destinationNodeCrosswalk[targetDestId] && pedestrianGraph[destinationNodeCrosswalk[targetDestId]]) {
        return destinationNodeCrosswalk[targetDestId];
    }
    const d = loc(targetDestId);
    let targetPos = null;

    if (d && (d.x !== undefined || d.position)) {
        targetPos = d.position || { x: d.x, y: 0, z: d.y };
    }

    const allNodeIds = Object.keys(pedestrianNodes);
    if (!allNodeIds.length) return targetDestId;

    if (!targetPos) {
        // Fallback to first available node in network
        return allNodeIds[0];
    }

    let closestId = allNodeIds[0];
    let minDist = Infinity;

    allNodeIds.forEach(id => {
        const nodePos = pedestrianNodes[id]?.position;
        if (nodePos) {
            const dist = distance3d(targetPos, nodePos);
            if (dist < minDist) {
                minDist = dist;
                closestId = id;
            }
        }
    });

    return closestId;
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

function injectSpatialSearchUI() {
    if ($("spatialSearchOverlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "spatialSearchOverlay";
    overlay.innerHTML = `
        <div class="spatial-search-header">
            <h3>Search 3D Map Locations</h3>
            <button id="spatialSearchCloseBtn">×</button>
        </div>
        <input type="text" id="spatialSearchInput" placeholder="Type a room name, area, or department..." autocomplete="off">
        <div id="spatialSearchResults"></div>
    `;
    document.body.appendChild(overlay);

    $("spatialSearchCloseBtn").onclick = () => { overlay.style.display = "none"; };

    $("spatialSearchInput").oninput = (e) => {
        const q = e.target.value.toLowerCase().trim();
        const resBox = $("spatialSearchResults");
        resBox.innerHTML = "";
        if (q.length < 2) return;

        const labels = window.pgs3d?.getSpatialLabels() || [];
        const matches = labels.filter(l => (l.name + " " + l.category).toLowerCase().includes(q)).slice(0, 15);

        matches.forEach(m => {
            const btn = document.createElement("button");
            btn.innerHTML = `<b>${escapeHtml(m.name)}</b><br><small>${m.category}</small>`;
            btn.onclick = () => {
                window.pgs3d?.focusSpatialLabel(m.id);
                overlay.style.display = "none";
                $("spatialSearchInput").value = "";
            };
            resBox.appendChild(btn);
        });
    };
}

function wireEvents() {
    if ($("routeBtn")) $("routeBtn").onclick = generateRoute;
    if ($("destinationCategory")) $("destinationCategory").onchange = event => populateSelects(event.target.value);

    document.addEventListener("change", e => {
        const cb = e.target.closest("input[type='checkbox']");
        if (!cb) return;

        if (cb.dataset["3dLayer"]) {
            window.pgs3d?.setLayerVisibility?.(cb.dataset["3dLayer"], cb.checked);
        }
        if (cb.dataset.semanticLabel) {
            window.pgs3d?.updateSemanticLabels?.();
        }
        if (cb.id === "threeDestinationsToggle") {
            window.pgs3d?.toggleDestinations?.(cb.checked);
        }
    });

    document.addEventListener("click", e => {
        const btn = e.target.closest("button");
        if (!btn) return;

        const id = (btn.id || "").toLowerCase();
        const text = (btn.textContent || btn.innerText || btn.title || "").toLowerCase().trim();

        if (btn.id === "routeBtn" || btn.classList.contains("quick-route")) return;

        if (id === "legendopen" || text === "legend" || text.includes("legend")) {
            togglePanelDisplay("legendPanel");
        } else if (id === "legendclose") {
            hidePanel("legendPanel");
        } else if (id === "layersopen" || text === "layers" || text.includes("layer")) {
            togglePanelDisplay("layersPanel");
        } else if (id === "layersclose") {
            hidePanel("layersPanel");
        } else if (text.includes("search") && id !== "searchclear" && id !== "spatialsearchclosebtn") {
            const overlay = $("spatialSearchOverlay");
            if (overlay) {
                const isVis = overlay.style.display === "block";
                overlay.style.display = isVis ? "none" : "block";
                if (!isVis) $("spatialSearchInput")?.focus();
            }
        } else if (text.includes("reset")) {
            window.pgs3d?.reset(); resetView();
        } else if (text.includes("fit route")) {
            fitRoute();
        }
    });

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
    window.onresize = () => { if (workspaceView === "2d") resetView(); };
}

function togglePanelDisplay(panelId) {
    const p = $(panelId);
    if (!p) return;
    const isHidden = p.classList.contains("hide") || p.style.display === "none";
    if (isHidden) {
        p.style.display = "block";
        p.classList.remove("hide");
        p.classList.add("show");
    } else {
        p.style.display = "none";
        p.classList.remove("show");
        p.classList.add("hide");
    }
}

function hidePanel(panelId) {
    const p = $(panelId);
    if (!p) return;
    p.style.display = "none";
    p.classList.remove("show");
    p.classList.add("hide");
}

function setWorkspaceView(next) {
    workspaceView = next === "3d" ? "3d" : "2d";
    const is3d = workspaceView === "3d";
    document.querySelector(".map-shell")?.classList.toggle("three-active", is3d);

    const isEditor = document.body.classList.contains('editor-active');
    if ($("mapFrame")) {
        $("mapFrame").style.display = isEditor ? "block" : (is3d ? "none" : "block");
        $("mapFrame").hidden = isEditor ? false : is3d;
    }
    if ($("threeFrame")) {
        $("threeFrame").style.display = "block";
        $("threeFrame").hidden = false;
    }

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
        g.innerHTML = `<circle class="pulse" r="0"></circle><circle class="marker-ring" r="12"></circle><circle class="marker-dot marker-core" r="8"></circle><text x="16" y="-9">${escapeHtml(d.label || d.name)}</text>`;
        g.onclick = () => { if (!["junction", "corridor"].includes(d.type)) if ($("endSelect")) $("endSelect").value = d.id; showDestination(d.id); };
        l.appendChild(g);
    });
}

function dijkstra(start, end, sourceGraph = graph) {
    const dist = {}, prev = {}, q = new Set(Object.keys(sourceGraph));
    Object.keys(sourceGraph).forEach(k => dist[k] = Infinity);
    dist[start] = 0;

    while (q.size) {
        let u = [...q].sort((a, b) => dist[a] - dist[b])[0];
        q.delete(u);
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

    // Dynamically snap start and end to the nearest pedestrian network node
    const startNode = findNearestPedestrianNode(start);
    const endNode = findNearestPedestrianNode(end);

    let spatialResult = null;
    if (pedestrianGraph[startNode] && pedestrianGraph[endNode]) {
        spatialResult = dijkstra(startNode, endNode, pedestrianGraph);
    }

    const hasSpatialPath = spatialResult && Array.isArray(spatialResult.path) && spatialResult.path.length >= 2 && Number.isFinite(spatialResult.distance);

    let result = dijkstra(start, end);
    lastPath = result.path;

    const startObj = loc(start) || { id: start, name: start };
    const endObj = loc(end) || { id: end, name: end };

    const spatialPositions = hasSpatialPath
        ? spatialResult.path.map(id => pedestrianNodes[id]?.position).filter(Boolean)
        : [];

    const totalDistMeters = hasSpatialPath ? spatialResult.distance : (result.distance || 50);

    drawRoute(result.path);
    updateTurnByTurnRoute(startObj, endObj, spatialPositions, totalDistMeters);
    showDestination(end);

    const routeDetail = {
        path: [...result.path],
        destinations: [startObj, endObj],
        distance: totalDistMeters,
        distanceUnit: hasSpatialPath ? "meters" : "map-units",
        certified: true,
        spatialNodeIds: hasSpatialPath ? [...spatialResult.path] : [],
        spatialPath: spatialPositions
    };

    window.pgsCurrentRoute = routeDetail;
    window.dispatchEvent(new CustomEvent("pgs:route", { detail: routeDetail }));
}

function edgeAllowsMode(edge, currentMode) {
    const allowed = (edge?.access || []).map(value => String(value).toLowerCase());
    if (!allowed.length || currentMode === "emergency") return true;
    return allowed.includes(currentMode) || allowed.includes("all") || allowed.includes("authorized");
}

function drawRoute(path) {
    const l = $("routeLayer"); if (!l) return; l.innerHTML = "";
    const points = path.map(id => loc(id)).filter(d => d && typeof d.x !== 'undefined' && typeof d.y !== 'undefined').map(d => `${d.x},${d.y}`).join(" ");
    if (!points) return;
    const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    pl.setAttribute("points", points); pl.setAttribute("class", "route"); pl.setAttribute("marker-end", "url(#arrow)");
    l.appendChild(pl);
    document.querySelectorAll(".node").forEach(n => n.classList.remove("selected"));
    path.forEach(id => document.querySelector(`.node[data-id="${id}"]`)?.classList.add("selected"));
}

// Generate Detailed Turn-by-Turn Text Instructions in Feet
function updateTurnByTurnRoute(startObj, endObj, positions, totalMeters) {
    const totalFeet = Math.round(totalMeters * 3.28084);
    const mins = Math.max(1, Math.round(totalFeet / 250));

    if ($("routeStatus")) $("routeStatus").textContent = "PEDESTRIAN NETWORK ROUTE";
    if ($("distanceMetric")) $("distanceMetric").textContent = totalFeet + " ft";
    if ($("timeMetric")) $("timeMetric").textContent = mins + " min";
    if ($("sumDistance")) $("sumDistance").textContent = totalFeet + " ft";
    if ($("sumTime")) $("sumTime").textContent = mins + " min";
    if ($("sumStart")) $("sumStart").textContent = startObj.name || startObj.id;
    if ($("sumEnd")) $("sumEnd").textContent = endObj.name || endObj.id;

    const steps = $("steps");
    if (!steps) return;
    steps.innerHTML = "";

    const instructions = [];
    instructions.push(`Exit <b>${escapeHtml(startObj.name)}</b> and enter the main pedestrian walkway.`);

    if (positions.length >= 2) {
        let currentDist = 0;
        for (let i = 0; i < positions.length - 1; i++) {
            const p1 = positions[i];
            const p2 = positions[i + 1];
            const legDistMeters = distance3d(p1, p2);
            const legDistFeet = Math.round(legDistMeters * 3.28084);
            currentDist += legDistFeet;

            if (i > 0 && i < positions.length - 1) {
                const p0 = positions[i - 1];
                const v1 = { x: p1.x - p0.x, z: p1.z - p0.z };
                const v2 = { x: p2.x - p1.x, z: p2.z - p1.z };

                // Cross product to determine left vs right turn
                const cross = v1.x * v2.z - v1.z * v2.x;
                const dot = v1.x * v2.x + v1.z * v2.z;
                const angle = Math.atan2(cross, dot) * (180 / Math.PI);

                if (angle > 30) {
                    instructions.push(`Proceed ${legDistFeet} ft, then turn <b>right</b> at the hallway intersection.`);
                } else if (angle < -30) {
                    instructions.push(`Proceed ${legDistFeet} ft, then turn <b>left</b> at the hallway intersection.`);
                } else if (legDistFeet > 60) {
                    instructions.push(`Continue straight along the spine corridor for ${legDistFeet} ft.`);
                }
            } else if (i === 0) {
                instructions.push(`Proceed straight along the walkway network for ${legDistFeet} ft.`);
            }
        }
    } else {
        instructions.push(`Proceed ${totalFeet} ft straight along the designated walkway.`);
    }

    instructions.push(`Arrive at <b>${escapeHtml(endObj.name)}</b> on your destination side.`);

    instructions.forEach((stepText, idx) => {
        const el = document.createElement("div");
        el.className = "step";
        el.innerHTML = `<b>${idx + 1}.</b> ${stepText}`;
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
    if (q.length < 2) { box.style.display = "none"; return; }
    const category = $("destinationCategory")?.value || "all";
    const matches = destinations
        .filter(d => !["junction", "corridor"].includes(d.type))
        .filter(d => matchesDestinationCategory(d, category))
        .filter(d => [d.name, d.id, d.label, d.category, d.zone, d.description].filter(Boolean).join(" ").toLowerCase().includes(q))
        .sort((a, b) => destinationGroup(a).localeCompare(destinationGroup(b)) || (a.name || a.id).localeCompare(b.name || b.id))
        .slice(0, 15);

    matches.forEach(d => {
        const btn = document.createElement("button");
        const displayName = escapeHtml(d.name || d.id || "Unnamed Room");
        btn.innerHTML = `<b>${displayName}</b><br><small>${escapeHtml(d.category || "Room")} • ${escapeHtml(d.access || "Standard")}</small>`;
        btn.onclick = () => {
            $("endSelect").value = d.id;
            showDestination(d.id);
            box.style.display = "none";
            $("searchBox").value = displayName;
            generateRoute();
        };
        box.appendChild(btn);
    });
    box.style.display = matches.length > 0 ? "block" : "none";
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
    if (workspaceView === "3d") {
        if (window.pgsCurrentRoute) {
            window.dispatchEvent(new CustomEvent("pgs:route", { detail: window.pgsCurrentRoute }));
        }
        return;
    }
    if (!lastPath.length) return;
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
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[m])); }

init();