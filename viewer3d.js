import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const host = document.getElementById("threeCanvas");
const frame = document.getElementById("threeFrame");
let renderer, labelRenderer, scene, camera, controls, model, resizeObserver;
let initialized = false, loading = false, visible = false;
const layerObjects = { site: [], ground: [], mezzanine: [], roof: [] };
const buildingLabels = [];
const semanticLabels = [];
const sourceLabelObjects = new Map();
const floorLayerIndex = new Map();
let spatialOverrides = {}, routeGroup, routeCurve, tracker;
let routeProgress = 0, trackingPaused = false, routeDuration = 24, lastFrameTime = performance.now();
let editorActive = false, editorGroup;
let editorNodes = [], editorEdges = [], editorActiveNodeId = null, editorHistory = [];
let labelOverrides = [], labelOverrideGroup, labelPlacementActive = false;
let destinationDrafts = [], destinationDraftGroup, destinationPlacementActive = false;
let pointerStart = null;
let animationFrameCount = 0;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function setStatus(message, { error = false, hidden = false } = {}) {
    const statusEl = document.getElementById("threeStatus");
    if (!statusEl) return;
    statusEl.classList.toggle("error", error);
    statusEl.classList.toggle("is-hidden", hidden);
    const span = statusEl.querySelector("span:last-child");
    if (span) span.textContent = message;
}

function initialize() {
    if (initialized) return;
    initialized = true;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071629);
    scene.fog = new THREE.Fog(0x071629, 900, 2800);

    camera = new THREE.PerspectiveCamera(45, 1, .1, 10000);
    camera.position.set(500, 420, 500);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1));
    labelRenderer.domElement.className = "three-label-layer";
    host.appendChild(labelRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * .49;

    scene.add(new THREE.HemisphereLight(0xdceeff, 0x19334d, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(300, 600, 250);
    scene.add(sun);
    const grid = new THREE.GridHelper(2400, 48, 0x225a83, 0x15344d);
    grid.material.opacity = .28;
    grid.material.transparent = true;
    scene.add(grid);

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(frame);

    document.querySelectorAll("#layersPanel input[type='checkbox']").forEach(input => {
        if (input.dataset["3dLayer"]) {
            input.addEventListener("change", () => setLayerVisibility(input.dataset["3dLayer"], input.checked));
        } else if (input.dataset.semanticLabel) {
            input.addEventListener("change", updateSemanticLabelVisibility);
        }
    });

    renderer.domElement.addEventListener("pointerdown", event => { pointerStart = { x: event.clientX, y: event.clientY }; });
    window.addEventListener("pgs:route", event => renderRoute(event.detail));
    animate();
}

async function loadModel() {
    if (model || loading) return;
    loading = true;
    setStatus("Preparing 3D twin…");
    try {
        const config = await fetch("data/config.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {});
        const modelUrl = config.views?.model || "assets/models/site_mobile.glb";

        const [destinationsPayload, labelsPayload, floorsPayload, baseNetworkPayload] = await Promise.all([
            fetch("data/generated/destination_spatial.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch("data/generated/spatial_labels.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch("data/generated/floor_layers.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
            fetch("data/generated/pedestrian_network.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}).catch(() => ({}))
        ]);

        spatialOverrides = destinationsPayload;
        floorLayerIndex.clear();
        (floorsPayload.layers || []).forEach(layer => floorLayerIndex.set(layer.floor_id, layer.code || "OUTDOOR"));

        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelUrl, event => {
            if (event.total) setStatus(`Loading 3D twin… ${Math.round(event.loaded / event.total * 100)}%`);
        });

        model = gltf.scene;
        scene.add(model);
        fitModel();
        indexLayers();
        createBuildingLabels();
        createSemanticLabels(labelsPayload.labels || []);
        applyInitialLayerState();

        if (window.pgsCurrentRoute) renderRoute(window.pgsCurrentRoute);
        setStatus("3D twin ready", { hidden: true });
    } catch (error) {
        setStatus("3D model is not available.", { error: true });
    } finally {
        loading = false;
    }
}

function classifyLayer(name) {
    if (/_RF(?:_|$)/i.test(name)) return "roof";
    if (/_MF(?:_|$)/i.test(name)) return "mezzanine";
    if (/_1F(?:_|$)/i.test(name)) return "ground";
    return "site";
}

function indexLayers() {
    Object.values(layerObjects).forEach(items => items.length = 0);
    model.children.forEach(object => layerObjects[classifyLayer(object.name)].push(object));
}

function setLayerVisibility(layer, isVisible) {
    (layerObjects[layer] || []).forEach(object => object.visible = isVisible);
    buildingLabels.forEach(label => {
        if (label.userData.layer === layer) label.visible = isVisible && !label.userData.overridden;
    });
    updateSemanticLabelVisibility();
}

function applyInitialLayerState() {
    setLayerVisibility("site", true);
    setLayerVisibility("ground", true);
    setLayerVisibility("mezzanine", false);
    setLayerVisibility("roof", false);

    const mezzCheck = document.querySelector("[data-3d-layer='mezzanine']");
    if (mezzCheck) mezzCheck.checked = false;
    const roofCheck = document.querySelector("[data-3d-layer='roof']");
    if (roofCheck) roofCheck.checked = false;
}

function buildingKey(name) { return name.replace(/_(?:1F|MF|RF)(?:_|$).*$/i, ""); }
function buildingName(key) {
    const known = {
        Root_Main_Building_F38: "Main Production Building",
        Root_Main_Security_F44: "Main Guard House",
        Root_Secondary_Security_F43: "Secondary Guard House",
        "Root_F32-Discharge-Testing_F32": "Cell Discharge Testing",
        "Root_F34-Hazardous_Waste_Storage_F34": "Hazardous Storage",
        "Root_F41-Storage_F41": "Safety Building"
    };
    return known[key] || key.replace(/^Root_/, "").replace(/_F\d+$/i, "").replace(/[_-]+/g, " ");
}

function createBuildingLabels() {
    const groups = new Map();
    model.children.filter(object => classifyLayer(object.name) === "ground").forEach(object => {
        const key = buildingKey(object.name);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(object);
    });
    groups.forEach((objects, key) => {
        const candidates = objects.filter(object => object.geometry);
        if (!candidates.length) return;
        candidates.forEach(object => { if (!object.geometry.boundingBox) object.geometry.computeBoundingBox(); });
        const volume = object => { const size = object.geometry.boundingBox.getSize(new THREE.Vector3()); return size.x * size.y * size.z; };
        const anchor = candidates.sort((a, b) => volume(b) - volume(a))[0];
        const box = anchor.geometry.boundingBox;
        const center = box.getCenter(new THREE.Vector3());
        center.y = box.max.y + Math.max(box.getSize(new THREE.Vector3()).y * .25, 2);

        const element = document.createElement("div");
        element.className = "three-label";
        element.textContent = buildingName(key);
        const label = new CSS2DObject(element);
        label.position.copy(center);
        label.userData = { layer: "ground", labelId: `building:${key}`, displayName: buildingName(key), category: "building" };
        anchor.add(label);
        buildingLabels.push(label);
        sourceLabelObjects.set(label.userData.labelId, label);
    });
}

function semanticKind(kind) {
    if (kind === "stair" || kind === "elevator") return "vertical";
    if (kind === "corridor" || kind === "amenity") return kind;
    return "room";
}

function semanticLayer(floorId) {
    const code = floorLayerIndex.get(floorId) || "1F";
    if (code === "MF") return "mezzanine";
    if (code === "RF") return "roof";
    if (code === "OUTDOOR") return "site";
    return "ground";
}

function createSemanticLabels(records) {
    records.forEach(record => {
        const position = record.model_position;
        if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) return;
        const guardHouse = /^(MAIN|SUB) GUARD HOUSE/i.test(record.name || "");
        const layer = semanticLayer(record.floor_id);
        const category = guardHouse ? "area" : layer === "site" ? "area" : semanticKind(record.kind);

        const element = document.createElement("div");
        element.className = "three-semantic-label";
        element.dataset.kind = category;
        element.textContent = guardHouse ? (/^MAIN/i.test(record.name) ? "Main Guard House" : "Secondary Guard House") : record.name;

        const label = new CSS2DObject(element);
        label.position.set(position.x, position.y + 1.5, position.z);
        label.userData = { category, layer, record, labelId: record.id, displayName: element.textContent };
        label.visible = false;
        model.add(label);
        semanticLabels.push(label);
        sourceLabelObjects.set(label.userData.labelId, label);
    });
    updateSemanticLabelVisibility();
}

function updateSemanticLabelVisibility() {
    const enabledCategories = new Set([...document.querySelectorAll("[data-semantic-label]:checked")].map(i => i.dataset.semanticLabel));
    const enabledLayers = new Set([...document.querySelectorAll("[data-3d-layer]:checked")].map(i => i.dataset["3dLayer"]));
    semanticLabels.forEach(label => {
        label.userData.enabled = enabledCategories.has(label.userData.category) && enabledLayers.has(label.userData.layer);
    });
    updateSemanticLabelLOD();
}

function updateSemanticLabelLOD() {
    if (!model || !camera) return;
    const world = new THREE.Vector3();
    semanticLabels.forEach(label => {
        const limit = label.userData.category === "room" || label.userData.category === "corridor" ? 260 : 420;
        label.getWorldPosition(world);
        label.visible = !label.userData.overridden && Boolean(label.userData.enabled) && world.distanceTo(camera.position) <= limit;
    });
}

function normalizeString(str) {
    if (!str) return "";
    return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function destinationPosition(destObj) {
    if (!destObj) return null;
    const id = typeof destObj === "string" ? destObj : destObj.id;
    const name = typeof destObj === "object" ? destObj.name : null;

    // 1. Spatial overrides check
    const override = (spatialOverrides.destinations || spatialOverrides)[id];
    if (override) {
        const pos = override.model_position || override;
        if ([pos?.x, pos?.y, pos?.z].every(Number.isFinite)) {
            return new THREE.Vector3(pos.x, Math.max(pos.y, 1.5), pos.z);
        }
    }

    // 2. Fuzzy Label search
    const labels = Array.from(sourceLabelObjects.values());
    const normId = normalizeString(id);
    const normName = normalizeString(name);

    const match = labels.find(l => normalizeString(l.userData.labelId) === normId) ||
        labels.find(l => normName && normalizeString(l.userData.displayName) === normName) ||
        labels.find(l => normName && (normalizeString(l.userData.displayName).includes(normName) || normName.includes(normalizeString(l.userData.displayName))));

    if (match) {
        const pos = new THREE.Vector3();
        match.getWorldPosition(pos);
        return new THREE.Vector3(pos.x, Math.max(pos.y, 1.5), pos.z);
    }

    return null;
}

function routePositions(route) {
    if (Array.isArray(route?.spatialPath) && route.spatialPath.length > 1) {
        return route.spatialPath
            .filter(p => [p?.x, p?.y, p?.z].every(Number.isFinite))
            .map(p => new THREE.Vector3(p.x, Math.max(p.y, 1.5), p.z));
    }

    const destinations = route?.destinations || [];
    if (destinations.length < 2) return [];

    const startPos = destinationPosition(destinations[0]);
    const endPos = destinationPosition(destinations.at(-1));

    if (!startPos || !endPos) return [];

    return [startPos, endPos];
}

function clearRoute() {
    if (routeGroup) {
        routeGroup.traverse(child => {
            child.geometry?.dispose?.();
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
            else child.material?.dispose?.();
        });
        model?.remove(routeGroup);
    }
    routeGroup = routeCurve = tracker = null;
}

function renderRoute(route) {
    if (!model) return;
    clearRoute();

    const points = routePositions(route);
    if (!points || points.length < 2) {
        setStatus("Selected destinations could not be mapped to 3D positions.", { error: true });
        return;
    }

    routeGroup = new THREE.Group();
    routeCurve = new THREE.CatmullRomCurve3(points, false, "centripetal", .35);
    const tube = new THREE.Mesh(
        new THREE.TubeGeometry(routeCurve, Math.max(64, points.length * 28), 1.15, 10, false),
        new THREE.MeshStandardMaterial({ color: 0x0788ff, emissive: 0x005dff, emissiveIntensity: 1.3, roughness: .25 })
    );
    routeGroup.add(tube);
    model.add(routeGroup);
    frameRoute(points);
}

function frameRoute(points) {
    const box = new THREE.Box3().setFromPoints(points);
    const center = box.getCenter(new THREE.Vector3()).add(model.position);
    const radius = Math.max(box.getSize(new THREE.Vector3()).x, box.getSize(new THREE.Vector3()).z, 40);
    controls.target.copy(center);
    camera.position.set(center.x + radius * .75, center.y + radius * .65, center.z + radius * .75);
    controls.update();
}

function fitModel() {
    if (!model) return;
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.position.y += size.y / 2;
    const radius = Math.max(size.x, size.y, size.z) * .72 || 100;
    camera.position.set(radius * .82, radius * .62, radius * .82);
    controls.target.set(0, Math.max(size.y * .12, 0), 0);
    controls.maxDistance = radius * 5;
    controls.update();
}

function resize() {
    if (!renderer || frame.hidden) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    labelRenderer.setSize(host.clientWidth, host.clientHeight);
}

function animate() {
    requestAnimationFrame(animate);
    if (!visible || !renderer) return;
    animationFrameCount = (animationFrameCount + 1) % 12;
    if (animationFrameCount === 0) updateSemanticLabelLOD();
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

window.pgs3d = {
    show: async () => { visible = true; initialize(); resize(); await loadModel(); },
    hide: () => { visible = false; },
    reset: () => { if (controls) { controls.reset(); resize(); fitModel(); } },

    getSpatialLabels: () => {
        return Array.from(sourceLabelObjects.values()).map(l => ({
            id: l.userData.labelId,
            name: l.userData.displayName,
            category: l.userData.category
        }));
    },

    focusSpatialLabel: (id) => {
        const label = sourceLabelObjects.get(id);
        if (!label || !camera || !controls) return;

        const layerToggle = document.querySelector(`[data-3d-layer='${label.userData.layer}']`);
        if (layerToggle && !layerToggle.checked) {
            layerToggle.checked = true;
            setLayerVisibility(label.userData.layer, true);
        }

        const pos = new THREE.Vector3();
        label.getWorldPosition(pos);
        controls.target.copy(pos);

        camera.position.set(pos.x + 30, pos.y + 60, pos.z + 40);
        controls.update();
    }
};