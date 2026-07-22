import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const host = document.getElementById("threeCanvas");
const frame = document.getElementById("threeFrame");
const status = document.getElementById("threeStatus");
let renderer, labelRenderer, scene, camera, controls, model, resizeObserver;
let initialized = false, loading = false, visible = false;
const layerObjects = { site: [], ground: [], mezzanine: [], roof: [] };
const buildingLabels = [];
const semanticLabels = [];
const sourceLabelObjects = new Map();
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
const EDITOR_STORAGE_KEY = "pgs-v10-pedestrian-network-draft";
const LABEL_STORAGE_KEY = "pgs-v10-label-overrides-draft";
const DESTINATION_STORAGE_KEY = "pgs-v10-destination-anchors-draft";

function setStatus(message, { error = false, hidden = false } = {}) {
    status.classList.toggle("error", error);
    status.classList.toggle("is-hidden", hidden);
    status.querySelector("span:last-child").textContent = message;
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

    const listeners = [
        { id: "threeWalkwaysToggle", event: "change", fn: (e) => { if (editorGroup) editorGroup.visible = e.target.checked; } },
        { id: "threeRouteToggle", event: "change", fn: (e) => { if (routeGroup) routeGroup.visible = e.target.checked; } },
        { id: "threeWalkToggle", event: "click", fn: toggleWalkPreview },
        { id: "threeEditToggle", event: "click", fn: toggleRouteEditor },
        { id: "threeEditUndo", event: "click", fn: undoEditorNode },
        { id: "threeEditSegment", event: "click", fn: startEditorSegment },
        { id: "threeEditDelete", event: "click", fn: deleteSelectedEditorNode },
        { id: "threeEditClear", event: "click", fn: clearEditorDraft },
        { id: "threeEditSave", event: "click", fn: saveEditorDraft },
        { id: "threeEditExport", event: "click", fn: exportEditorDraft },
        { id: "threeEditImport", event: "click", fn: () => document.getElementById("threeEditImportFile").click() },
        { id: "threeEditImportFile", event: "change", fn: importEditorDraft },
        { id: "threeLabelTarget", event: "change", fn: selectLabelTarget },
        { id: "threeLabelPlace", event: "click", fn: startLabelPlacement },
        { id: "threeLabelRemove", event: "click", fn: removeLabelOverride },
        { id: "threeLabelSave", event: "click", fn: saveLabelOverrides },
        { id: "threeLabelExport", event: "click", fn: exportLabelOverrides },
        { id: "threeLabelImport", event: "click", fn: () => document.getElementById("threeLabelImportFile").click() },
        { id: "threeLabelImportFile", event: "change", fn: importLabelOverrides },
        { id: "threeDestinationSource", event: "change", fn: selectDestinationSource },
        { id: "threeDestinationPlace", event: "click", fn: startDestinationPlacement },
        { id: "threeDestinationRemove", event: "click", fn: removeDestinationDraft },
        { id: "threeDestinationExport", event: "click", fn: exportDestinationDrafts },
        { id: "threeDestinationImport", event: "click", fn: () => document.getElementById("threeDestinationImportFile").click() },
        { id: "threeDestinationImportFile", event: "change", fn: importDestinationDrafts }
    ];

    listeners.forEach(l => {
        const el = document.getElementById(l.id);
        if (el) el.addEventListener(l.event, l.fn);
    });

    renderer.domElement.addEventListener("pointerdown", event => { pointerStart = { x: event.clientX, y: event.clientY }; });
    renderer.domElement.addEventListener("pointerup", handleEditorPointerUp);
    window.addEventListener("pgs:route", event => renderRoute(event.detail));
    animate();
}

async function loadModel() {
    if (model) { console.log("PGS 3D: Model already exists."); return; }
    if (loading) return;
    loading = true;
    console.log("PGS 3D: Starting loadModel()...");
    setStatus("Preparing 3D twin…");
    try {
        const config = await fetch("data/config.json", { cache: "no-store" }).then(r => r.json());
        const modelUrl = config.views?.model || "assets/models/site_mobile.glb";
        console.log("PGS 3D: Target:", modelUrl);

        const [destPayload, labelPayload, floorPayload, netPayload] = await Promise.all([
            fetch("data/generated/destination_spatial.json").then(r => r.json()).catch(() => ({})),
            fetch("data/generated/spatial_labels.json").then(r => r.json()).catch(() => ({})),
            fetch("data/generated/floor_layers.json").then(r => r.json()).catch(() => ({})),
            fetch("data/generated/pedestrian_network.json").then(r => r.json()).catch(() => ({}))
        ]);

        spatialOverrides = destPayload;
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelUrl);
        model = gltf.scene;
        scene.add(model);
        fitModel();
        console.log("PGS 3D: Model added to scene.");
        setStatus("3D twin ready", { hidden: true });
    } catch (e) {
        console.error("PGS 3D Critical Load Error:", e);
        setStatus("Load Error: " + e.message, { error: true });
    } finally {
        loading = false;
    }
}

function fitModel() {
    if (!model) return;
    const box = new THREE.Box3().setFromObject(model);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    model.position.sub(center);
    model.position.y += size.y / 2;
    const radius = Math.max(size.x, size.y, size.z) * .72 || 100;
    camera.near = Math.max(radius / 10000, .1);
    camera.far = Math.max(radius * 20, 5000);
    camera.position.set(radius * .82, radius * .62, radius * .82);
    camera.updateProjectionMatrix();
    controls.target.set(0, Math.max(size.y * .12, 0), 0);
    controls.minDistance = Math.max(radius * .08, 1);
    controls.maxDistance = radius * 5;
    controls.update();
    controls.saveState();
}

function resize() {
    if (!renderer || frame.hidden) return;
    const width = Math.max(host.clientWidth, 1), height = Math.max(host.clientHeight, 1);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    labelRenderer.setSize(width, height);
}

function animate() {
    requestAnimationFrame(animate);
    if (!visible || !renderer) return;
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

async function show() {
    visible = true;
    initialize();
    resize();
    await loadModel();
}

function hide() { visible = false; }
function reset() { if (controls) { controls.reset(); resize(); } }

window.pgs3d = { show, hide, reset };

// Include helper functions: classifyLayer, indexLayers, setLayerVisibility, etc.
// (These are the rest of your original functions that were in your file)