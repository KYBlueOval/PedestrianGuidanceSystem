let destinations = [], routes = [], quickRoutes = [], graph = {}, lastPath = [], mode = "employee";
let pedestrianNetwork = null, pedestrianGraph = {}, pedestrianNodes = {}, destinationNodeCrosswalk = {};
let spatialLabelsData = [];
let view = { scale: 1, x: 0, y: 0 }, dragging = false, dragStart = null;
let workspaceView = "3d";
let config = {};
const MAP_W = 1024, MAP_H = 768;
const EDITOR_STORAGE_KEY = "pgs-v10-pedestrian-network-draft";
const $ = id => document.getElementById(id);
const loc = id => destinations.find(d => d.id === id);
const fetchJson = url => fetch(url, { cache: "no-store" });

// GPS Reference Origin Coordinates (Maps GLB 0,0 to Facility Reference Point)
const ORIGIN_LAT = 37.532810;  // Latitude at GLB origin (0,0)
const ORIGIN_LNG = -85.820120; // Longitude at GLB origin (0,0)
const METERS_PER_LAT = 111000;
const METERS_PER_LNG = 88000;  // Adjusted for local latitude

async function init() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => { for (let r of regs) r.unregister(); });
    }
    if ('caches' in window) {
        caches.keys().then(names => { for (let n of names) caches.delete(n); });
    }

    config = await fetchJson("data/config.json").then(r => r.ok ? r.json() : {}).catch(() => ({}));

    let rawDestinations = [], spatialLabelsPayload = {}, basePedestrianNetwork = null;
    [rawDestinations, routes, quickRoutes, basePedestrianNetwork, spatialLabelsPayload] = await Promise.all([
        fetchJson("data/destinations.json").then(r => r.json()).catch(() => []),
        fetchJson("data/routes.json").then(r => r.json()).catch(() => []),
        fetchJson("data/quick_routes.json").then(r => r.json()).catch(() => []),
        fetchJson("data/generated/pedestrian_network.json").then(r => r.ok ? r.json() : null).catch(() => null),
        fetchJson("data/generated/spatial_labels.json").then(r => r.ok ? r.json() : {}).catch(() => ({}))
    ]);

    spatialLabelsData = spatialLabelsPayload.labels || [];

    // Prioritize draft network saved in localStorage if available
    try {
        const savedDraft = JSON.parse(localStorage.getItem(EDITOR_STORAGE_KEY) || "null");
        if (savedDraft && Array.isArray(savedDraft.nodes) && savedDraft.nodes.length > 0) {
            pedestrianNetwork = savedDraft;
        } else {
            pedestrianNetwork = basePedestrianNetwork;
        }
    } catch {
        pedestrianNetwork = basePedestrianNetwork;
    }

    const crosswalk = await fetchJson("data/generated/destination_node_crosswalk.json").then(r => r.ok ? r.json() : null).catch(() => null);
    if (crosswalk) {
        destinationNodeCrosswalk = Object.fromEntries(
            (crosswalk.destinations || []).map(item => [item.destination_id, item.node_id])
        );
    }

    buildPedestrianGraph();
    destinations = mergeSpatialLabelsIntoDestinations(rawDestinations, spatialLabelsData);

    buildGraph();
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
        document.querySelectorAll('.editor-control, .editor-bar, #editorPanel, #threeEditorPanel, [data-editor-ui], .editor-ui, .editor-drawer, .editor-sidebar').forEach(el => {
            el.style.display = 'block';
            el.hidden = false;
        });

        setupEditorTabs();

        if (typeof initPedestrianNetworkEditor === "function") initPedestrianNetworkEditor();
        if (typeof initMapLabelEditor === "function") initMapLabelEditor();
        if (typeof initDestinationAnchorEditor === "function") initDestinationAnchorEditor();
    }

    setWorkspaceView("3d");
    updateClock();
    setInterval(updateClock, 30000);

    // Initialize Mobile Location & Orientation Sensors
    initMobileGPS();
    initCompassHeading();
}

function mergeSpatialLabelsIntoDestinations(existingDests, spatialLabels) {
    const map = new Map();
    existingDests.forEach(d => map.set(d.id, d));

    spatialLabels.forEach(record => {
        if (!record.id || !record.name) return;
        const cleanId = record.id;
        const pos = record.model_position || {};

        if (!map.has(cleanId)) {
            map.set(cleanId, {
                id: cleanId,
                name: record.name,
                label: record.name,
                type: "room",
                category: record.kind || "room",
                zone: record.floor_id === "FL_MF" ? "Mezzanine" : "Production",
                access: "Authorized Personnel",
                position: { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 },
                description: `Facility Room (${record.review_status || "mapped"})`
            });
        } else {
            const existing = map.get(cleanId);
            if (!existing.position || !Number.isFinite(existing.position.x)) {
                existing.position = { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 };
            }
        }
    });

    return Array.from(map.values());
}

function setupEditorTabs() {
    document.querySelectorAll('.editor-tab-btn').forEach(btn => {
        btn.onclick = (e) => {
            document.querySelectorAll('.editor-tab-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');

            const targetTab = e.target.dataset.tab;
            if ($('editorTabWalkway')) $('editorTabWalkway').style.display = targetTab === 'walkway' ? 'block' : 'none';
            if ($('editorTabLabel')) $('editorTabLabel').style.display = targetTab === 'label' ? 'block' : 'none';
            if ($('editorTabAnchor')) $('editorTabAnchor').style.display = targetTab === 'anchor' ? 'block' : 'none';
        };
    });
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
    const cat = (destination.category || "").toLowerCase();
    const zone = (destination.zone || "").toLowerCase();
    const type = (destination.type || "").toLowerCase();

    // 1. Individual Rooms & Offices
    if (cat === "room" || type === "room" || cat === "office") return "Individual Rooms & Offices";

    // 2. Departments & Production Areas
    if (cat === "department" || cat === "production" || zone === "production") return "Department / Key Areas";

    // 3. Security & Entrances ONLY if explicitly security or entrance
    if (zone === "security" || cat === "security" || cat === "entrance") return "Entrances / Security";

    // 4. Visitor / Check-In
    if (zone === "visitor" || cat === "visitor") return "Visitor / Check-In";

    // 5. Amenities & Employee Services
    if (zone === "amenities" || cat === "amenity" || cat === "service") return "Amenities / Services";

    // 6. Emergency / Muster
    if (zone === "emergency" || cat === "emergency") return "Emergency / Muster";

    // Fallback
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

function get3DPositionForDestination(targetDestId) {
    const d = loc(targetDestId);
    if (d && d.position && Number.isFinite(d.position.x) && (d.position.x !== 0 || d.position.z !== 0)) {
        return d.position;
    }

    const matchLabel = spatialLabelsData.find(l =>
        l.id === targetDestId ||
        l.name?.toLowerCase() === d?.name?.toLowerCase() ||
        l.id === destinationNodeCrosswalk[targetDestId]
    );

    if (matchLabel?.model_position && Number.isFinite(matchLabel.model_position.x)) {
        return matchLabel.model_position;
    }

    return null;
}

// ROBUST 3D NODE SNAPPING BY 3D VECTOR
function findNearestPedestrianNodeByPos(pos) {
    if (!pos || !Number.isFinite(pos.x)) return null;

    const connectedNodeIds = Object.keys(pedestrianNodes).filter(id => (pedestrianGraph[id] || []).length > 0);
    if (!connectedNodeIds.length) return null;

    let closestId = connectedNodeIds[0];
    let minDist = Infinity;

    connectedNodeIds.forEach(id => {
        const nodePos = pedestrianNodes[id]?.position;
        if (nodePos) {
            const dist = distance3d(pos, nodePos);
            if (dist < minDist) {
                minDist = dist;
                closestId = id;
            }
        }
    });

    return closestId;
}

// ROBUST 3D NODE SNAPPING & DRAFT ANCHOR RESOLVER
function findNearestPedestrianNode(targetDestId) {
    if (!targetDestId) return null;

    // 1. Direct match in pedestrian graph
    if (pedestrianGraph[targetDestId] && pedestrianGraph[targetDestId].length > 0) {
        return targetDestId;
    }

    // 2. Check destination crosswalk override map
    if (destinationNodeCrosswalk[targetDestId] && pedestrianGraph[destinationNodeCrosswalk[targetDestId]]) {
        return destinationNodeCrosswalk[targetDestId];
    }

    // 3. Check Destination Drafts (local storage anchors)
    try {
        const savedAnchors = JSON.parse(localStorage.getItem("pgs-v10-destination-anchors-draft") || "null");
        if (savedAnchors && Array.isArray(savedAnchors.destinations)) {
            const matchAnchor = savedAnchors.destinations.find(a => a.id === targetDestId || a.source_label_id === targetDestId);
            if (matchAnchor && matchAnchor.network_node_id && pedestrianGraph[matchAnchor.network_node_id]) {
                return matchAnchor.network_node_id;
            }
        }
    } catch { }

    // 4. Look up physical 3D Position (resolves destination-draft:label:...)
    let targetPos = get3DPositionForDestination(targetDestId);

    if (!targetPos) {
        const dObj = loc(targetDestId);
        const searchName = (dObj?.name || targetDestId).toLowerCase().trim();

        const match = spatialLabelsData.find(l =>
            l.id === targetDestId ||
            (l.name && l.name.toLowerCase().trim() === searchName)
        );

        if (match?.model_position && Number.isFinite(match.model_position.x)) {
            targetPos = match.model_position;
        }
    }

    // 5. Snap 3D Position to nearest connected red node
    if (!targetPos) return targetDestId;
    return findNearestPedestrianNodeByPos(targetPos) || targetDestId;
}

// Real-Time GPS Tracking & 3D Model Snapping
function initMobileGPS() {
    if (!navigator.geolocation) return;

    navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;

            // Convert GPS Delta to 3D Model Coordinates
            const x3d = (lng - ORIGIN_LNG) * METERS_PER_LNG;
            const z3d = -(lat - ORIGIN_LAT) * METERS_PER_LAT;
            const userPos = { x: x3d, y: 0.35, z: z3d };

            // Update user position marker in 3D Scene
            if (window.pgs3d?.updateUserPosition) {
                window.pgs3d.updateUserPosition(userPos);
            }

            // Auto-snap start dropdown to closest node in network
            const nearestNodeId = findNearestPedestrianNodeByPos(userPos);
            if (nearestNodeId && $("startSelect") && $("startSelect").value !== nearestNodeId) {
                $("startSelect").value = nearestNodeId;
                generateRoute();
            }
        },
        (err) => console.warn("GPS Tracking Error:", err),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 5000 }
    );
}

// Real-time Digital Compass Heading Rotation
function initCompassHeading() {
    const handleOrientation = (e) => {
        let heading = null;

        // iOS / Safari
        if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
            heading = e.webkitCompassHeading;
        }
        // Android / Chrome (Absolute Alpha)
        else if (e.alpha !== null && e.alpha !== undefined) {
            heading = (360 - e.alpha) % 360;
        }

        if (heading !== null && window.pgs3d?.setCameraHeading) {
            window.pgs3d.setCameraHeading(heading);
        }
    };

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS Motion Permission request
        DeviceOrientationEvent.requestPermission().then(state => {
            if (state === 'granted') {
                window.addEventListener('deviceorientation', handleOrientation, true);
            }
        }).catch(err => console.warn("DeviceOrientation permission error:", err));
    } else {
        window.addEventListener('deviceorientationabsolute', handleOrientation, true);
        window.addEventListener('deviceorientation', handleOrientation, true);
    }
}

function matchesDestinationCategory(destination, category) {
    if (category === "all") return true;
    if (category === "visitor") return destination.zone === "Visitor" || (destination.category && destination.category.includes("visitor"));
    if (category === "security") return destination.zone === "Security" || destination.category === "security";
    if (category === "production") return destination.zone === "Production" || destination.category === "department" || destination.category === "room";
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

// -----------------------------------------------------------
// DYNAMIC QUICK ROUTES FROM CURRENT START LOCATION
// -----------------------------------------------------------
function renderQuickRoutes() {
    const wrap = $("quickRoutes");
    if (!wrap) return;
    wrap.innerHTML = "";

    const customQuickRoutes = [
        { label: "Closest Plant Exit", type: "exit" },
        { label: "Closest Restroom", type: "restroom" },
        { label: "Closest Break Area", type: "break" },
        { label: "Closest Emergency / Muster", type: "muster" }
    ];

    customQuickRoutes.forEach(q => {
        const btn = document.createElement("button");
        btn.className = "quick-route";
        btn.innerHTML = `<span>⚡ ${escapeHtml(q.label)}</span><b>→</b>`;
        btn.onclick = () => routeToClosest(q.type);
        wrap.appendChild(btn);
    });
}

function routeToClosest(targetType) {
    const startId = $("startSelect")?.value;
    if (!startId) return;

    let candidates = [];

    if (targetType === "exit") {
        candidates = destinations.filter(d =>
            /guard house|turnstile|exit|exterior door|access door/i.test(d.name + " " + d.id + " " + (d.category || ""))
        );
    } else if (targetType === "restroom") {
        candidates = destinations.filter(d =>
            /restroom|toilet|men|women|locker/i.test(d.name + " " + d.id + " " + (d.category || ""))
        );
    } else if (targetType === "break") {
        candidates = destinations.filter(d =>
            /break|canteen|kitchen|lounge|amenity/i.test(d.name + " " + d.id + " " + (d.category || ""))
        );
    } else if (targetType === "muster") {
        candidates = destinations.filter(d =>
            /muster|emergency|evacuation|assembly point/i.test(d.name + " " + d.id + " " + (d.category || ""))
        );
    }

    if (!candidates.length) {
        alert(`No locations found for category: ${targetType}`);
        return;
    }

    const startNode = findNearestPedestrianNode(startId);
    let bestDest = null;
    let shortestDist = Infinity;

    candidates.forEach(cand => {
        const candidateNode = findNearestPedestrianNode(cand.id);
        if (pedestrianGraph[startNode] && pedestrianGraph[candidateNode]) {
            const res = dijkstra(startNode, candidateNode, pedestrianGraph);
            if (res && res.distance < shortestDist) {
                shortestDist = res.distance;
                bestDest = cand;
            }
        }
    });

    if (!bestDest) {
        bestDest = candidates[0];
    }

    populateSelects("all");
    if ($("endSelect")) $("endSelect").value = bestDest.id;

    generateRoute();
    fitRoute();
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

        const matches = destinations
            .filter(d => (d.name + " " + (d.category || "") + " " + (d.id || "")).toLowerCase().includes(q))
            .slice(0, 15);

        matches.forEach(m => {
            const btn = document.createElement("button");
            btn.innerHTML = `<b>${escapeHtml(m.name)}</b><br><small>${m.category || "Room"}</small>`;
            btn.onclick = () => {
                $("endSelect").value = m.id;
                showDestination(m.id);
                overlay.style.display = "none";
                $("spatialSearchInput").value = "";
                window.pgs3d?.focusSpatialLabel(m.id);
                generateRoute();
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

    // Default to "All Categories" for all modes, including Employee
    if ($("destinationCategory")) $("destinationCategory").value = "all";
    populateSelects("all");

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

// STRICT WALKPATH ROUTE GENERATION
function generateRoute() {
    const sSelect = $("startSelect"), eSelect = $("endSelect");
    if (!sSelect || !eSelect) return;
    const start = sSelect.value, end = eSelect.value;
    if (!start || !end || start === end) return;

    // Reload latest pedestrian draft from localStorage if available
    try {
        const savedDraft = JSON.parse(localStorage.getItem(EDITOR_STORAGE_KEY) || "null");
        if (savedDraft && Array.isArray(savedDraft.nodes) && savedDraft.nodes.length > 0) {
            pedestrianNetwork = savedDraft;
            buildPedestrianGraph();
        }
    } catch { }

    const startNode = findNearestPedestrianNode(start);
    const endNode = findNearestPedestrianNode(end);

    if (startNode === endNode && start !== end) {
        console.warn(`Start (${start}) and End (${end}) snapped to same node (${startNode}).`);
    }

    let spatialResult = null;
    if (pedestrianGraph[startNode] && pedestrianGraph[endNode]) {
        spatialResult = dijkstra(startNode, endNode, pedestrianGraph);
    }

    const hasSpatialPath = spatialResult &&
        Array.isArray(spatialResult.path) &&
        spatialResult.path.length >= 2 &&
        Number.isFinite(spatialResult.distance) &&
        spatialResult.distance < Infinity;

    const startObj = loc(start) || { id: start, name: start };
    const endObj = loc(end) || { id: end, name: end };

    let spatialPositions = [];

    if (hasSpatialPath) {
        spatialPositions = spatialResult.path.map(id => pedestrianNodes[id]?.position).filter(Boolean);
    } else {
        console.warn(`No spatial path found between ${startNode} and ${endNode}.`);
        if ($("routeStatus")) $("routeStatus").textContent = "NETWORK GAP DETECTED";
        renderStepInstructions(startObj, endObj, [], 0, false);
        return;
    }

    const totalDistMeters = spatialResult.distance;

    drawRoute(spatialResult.path);
    renderStepInstructions(startObj, endObj, spatialPositions, totalDistMeters, true, spatialResult.path);
    showDestination(end);

    const routeDetail = {
        path: [...spatialResult.path],
        destinations: [startObj, endObj],
        distance: totalDistMeters,
        distanceUnit: "meters",
        certified: true,
        spatialNodeIds: [...spatialResult.path],
        spatialPath: spatialPositions
    };

    window.pgsCurrentRoute = routeDetail;
    window.dispatchEvent(new CustomEvent("pgs:route", { detail: routeDetail }));
}

function edgeAllowsMode(edge, currentMode) {
    if (!edge || !edge.access || !edge.access.length) return true;
    const allowed = edge.access.map(v => String(v).toLowerCase());
    return allowed.includes("all") || allowed.includes("authorized") || allowed.includes(currentMode);
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

// SMART VECTOR-COMPACTING, INTERSECTION & CORRIDOR LANDMARK-AWARE INSTRUCTIONS
function renderStepInstructions(startObj, endObj, positions, totalMeters, isValid, pathNodeIds = []) {
    const totalFeet = Math.round(totalMeters * 3.28084);
    const mins = Math.max(1, Math.round(totalFeet / 250));

    if ($("routeStatus")) $("routeStatus").textContent = isValid ? "PEDESTRIAN NETWORK ROUTE" : "NETWORK DISCONNECTED";
    if ($("distanceMetric")) $("distanceMetric").textContent = totalFeet + " ft";
    if ($("timeMetric")) $("timeMetric").textContent = mins + " min";
    if ($("sumDistance")) $("sumDistance").textContent = totalFeet + " ft";
    if ($("sumTime")) $("sumTime").textContent = mins + " min";
    if ($("sumStart")) $("sumStart").textContent = startObj.name || startObj.id;
    if ($("sumEnd")) $("sumEnd").textContent = endObj.name || endObj.id;

    let stepsContainer = $("steps") || $("routeSteps");
    if (!stepsContainer) {
        const statusSec = document.querySelector(".route-status");
        if (statusSec) {
            stepsContainer = document.createElement("div");
            stepsContainer.id = "steps";
            stepsContainer.className = "turn-instructions-box";
            statusSec.appendChild(stepsContainer);
        }
    }

    if (!stepsContainer) return;
    stepsContainer.innerHTML = "";

    if (!isValid) {
        stepsContainer.innerHTML = `<div class="step-error">⚠️ <b>Network Gap Detected:</b> Walkway nodes between ${escapeHtml(startObj.name)} and ${escapeHtml(endObj.name)} are disconnected in 3D Editor.</div>`;
        return;
    }

    // Advanced Landmark Finder: Scans 3D positions for significant nearby locations
    const findLandmarkForLeg = (legPositions) => {
        if (!legPositions || !legPositions.length) return null;
        let bestName = null;
        let bestScore = -1;

        legPositions.forEach(pos => {
            if (!pos) return;
            destinations.forEach(d => {
                if (!d.name || !d.position || !Number.isFinite(d.position.x)) return;
                if (d.id === startObj.id || d.id === endObj.id) return;

                const dist = distance3d(pos, d.position);
                if (dist <= 10.0) { // Scan within ~33 feet (10m) of walkway path
                    let score = 100 - dist;

                    const lowerName = d.name.toLowerCase();
                    const category = (d.category || "").toLowerCase();

                    // Boost score for major pedestrian landmarks vs small storage closets
                    if (lowerName.includes("break area") || lowerName.includes("office") || lowerName.includes("locker")) score += 50;
                    if (category.includes("department") || category.includes("room")) score += 20;
                    if (lowerName.includes("storage") || lowerName.includes("files")) score -= 30;

                    if (score > bestScore) {
                        bestScore = score;
                        bestName = d.name;
                    }
                }
            });
        });

        return bestName;
    };

    const instructions = [];
    instructions.push(`Exit <b>${escapeHtml(startObj.name)}</b> onto the pedestrian walkway network.`);

    if (positions.length >= 2) {
        let accumulatedFeet = 0;
        let legPositions = [positions[0]];

        for (let i = 0; i < positions.length - 1; i++) {
            const p1 = positions[i];
            const p2 = positions[i + 1];
            const currentNId = pathNodeIds[i + 1];
            const segDist = Math.round(distance3d(p1, p2) * 3.28084);

            accumulatedFeet += segDist;
            legPositions.push(p2);

            let isTurn = false;
            let turnDirection = "";
            let isSpineIntersection = (currentNId === "draft-node-9");

            if (i < positions.length - 2) {
                const p3 = positions[i + 2];
                const v1 = { x: p2.x - p1.x, z: p2.z - p1.z };
                const v2 = { x: p3.x - p2.x, z: p3.z - p2.z };

                const cross = v1.x * v2.z - v1.z * v2.x;
                const dot = v1.x * v2.x + v1.z * v2.z;
                const angle = Math.atan2(cross, dot) * (180 / Math.PI);

                if (angle > 38) {
                    isTurn = true;
                    turnDirection = "right";
                } else if (angle < -38) {
                    isTurn = true;
                    turnDirection = "left";
                }
            }

            const landmarkName = findLandmarkForLeg(legPositions);

            if (isSpineIntersection && !isTurn) {
                instructions.push(`Proceed straight for <b>${accumulatedFeet} ft</b> through the <b>Spine Intersection</b>.`);
                accumulatedFeet = 0;
                legPositions = [p2];
            } else if (isTurn) {
                let stepText = `Proceed straight for <b>${accumulatedFeet} ft</b>`;
                if (landmarkName) {
                    stepText += ` past <b>${escapeHtml(landmarkName)}</b>`;
                }
                stepText += `, then turn <b>${turnDirection}</b> into the corridor.`;

                instructions.push(stepText);
                accumulatedFeet = 0;
                legPositions = [p2];
            } else if (i === positions.length - 2 && accumulatedFeet > 0) {
                let endStraightText = `Continue straight along walkway for <b>${accumulatedFeet} ft</b>`;
                if (landmarkName) {
                    endStraightText += ` past <b>${escapeHtml(landmarkName)}</b> towards destination`;
                } else {
                    endStraightText += ` towards destination`;
                }
                instructions.push(`${endStraightText}.`);
            }
        }
    } else {
        instructions.push(`Proceed straight along walkway for <b>${totalFeet} ft</b>.`);
    }

    instructions.push(`Arrive at <b>${escapeHtml(endObj.name)}</b> (Destination adjacent).`);

    instructions.forEach((stepText, idx) => {
        const el = document.createElement("div");
        el.className = "step-item";
        el.style.cssText = "padding: 8px 10px; margin-top: 6px; background: rgba(15, 32, 58, 0.75); border-left: 3px solid #00a8ff; border-radius: 4px; font-size: 12px; color: #e0e0e0; line-height: 1.35;";
        el.innerHTML = `<b>Step ${idx + 1}:</b> ${stepText}`;
        stepsContainer.appendChild(el);
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