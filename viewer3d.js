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
const floorLayerIndex = new Map();
let spatialOverrides = {}, routeGroup, routeCurve, tracker;
let routeProgress = 0, trackingPaused = false, routeDuration = 24, lastFrameTime = performance.now();
let editorActive = false, editorGroup;
let editorNodes = [], editorEdges = [], editorActiveNodeId = null, editorHistory = [];
let labelOverrides = [], labelOverrideGroup, labelPlacementActive = false;
let destinationDrafts = [], destinationDraftGroup, destinationPlacementActive = false;
let pointerStart = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

// --- 1. FUNCTION DECLARATIONS (Must come before wiring) ---
function setStatus(message, { error = false, hidden = false } = {}) {
    status.classList.toggle("error", error);
    status.classList.toggle("is-hidden", hidden);
    status.querySelector("span:last-child").textContent = message;
}

function toggleWalkPreview() { trackingPaused = !trackingPaused; }
function toggleRouteEditor() { editorActive = !editorActive; rebuildEditorVisuals(); }
function undoEditorNode() { /* handle undo */ }
function startEditorSegment() { editorActiveNodeId = null; }
function deleteSelectedEditorNode() { /* handle delete */ }
function clearEditorDraft() { /* handle clear */ }
function saveEditorDraft() { /* handle save */ }
function exportEditorDraft() { /* handle export */ }
function importEditorDraft(e) { /* handle import */ }
function selectLabelTarget() { /* handle select */ }
function startLabelPlacement() { labelPlacementActive = true; }
function removeLabelOverride() { /* handle remove */ }
function saveLabelOverrides() { /* handle save */ }
function exportLabelOverrides() { /* handle export */ }
function importLabelOverrides(e) { /* handle import */ }
function selectDestinationSource() { /* handle select */ }
function startDestinationPlacement() { destinationPlacementActive = true; }
function removeDestinationDraft() { /* handle remove */ }
function exportDestinationDrafts() { /* handle export */ }
function importDestinationDrafts(e) { /* handle import */ }

// --- 2. INITIALIZATION ---
function initialize() {
    if (initialized) return;
    initialized = true;
    
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071629);
    camera = new THREE.PerspectiveCamera(45, 1, .1, 10000);
    camera.position.set(500, 420, 500);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    host.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(host.clientWidth, host.clientHeight);
    labelRenderer.domElement.className = "three-label-layer";
    host.appendChild(labelRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);

    // NOW wire listeners because all functions above exist
    const listeners = [
        { id: "threeWalkToggle", event: "click", fn: toggleWalkPreview },
        { id: "threeEditToggle", event: "click", fn: toggleRouteEditor },
        { id: "threeEditUndo", event: "click", fn: undoEditorNode },
        { id: "threeEditSegment", event: "click", fn: startEditorSegment },
        { id: "threeEditDelete", event: "click", fn: deleteSelectedEditorNode },
        { id: "threeEditClear", event: "click", fn: clearEditorDraft },
        { id: "threeEditSave", event: "click", fn: saveEditorDraft },
        { id: "threeEditExport", event: "click", fn: exportEditorDraft },
        { id: "threeLabelTarget", event: "change", fn: selectLabelTarget },
        { id: "threeLabelPlace", event: "click", fn: startLabelPlacement },
        { id: "threeLabelRemove", event: "click", fn: removeLabelOverride },
        { id: "threeLabelSave", event: "click", fn: saveLabelOverrides },
        { id: "threeLabelExport", event: "click", fn: exportLabelOverrides },
        { id: "threeDestinationSource", event: "change", fn: selectDestinationSource },
        { id: "threeDestinationPlace", event: "click", fn: startDestinationPlacement },
        { id: "threeDestinationRemove", event: "click", fn: removeDestinationDraft },
        { id: "threeDestinationExport", event: "click", fn: exportDestinationDrafts }
    ];

    listeners.forEach(l => {
        const el = document.getElementById(l.id);
        if (el) el.addEventListener(l.event, l.fn);
    });

    animate();
}

async function loadModel() {
    if (model) return;
    try {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync("assets/models/site_mobile.glb");
        model = gltf.scene;
        scene.add(model);
        setStatus("3D twin ready", { hidden: true });
    } catch (e) {
        setStatus("Model Load Error: " + e.message, { error: true });
    }
}

function animate() {
    requestAnimationFrame(animate);
    if (!visible) return;
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
}

function resize() {
    if (!renderer) return;
    const w = host.clientWidth, h = host.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
}

async function show() {
    visible = true;
    initialize();
    resize();
    await loadModel();
}

function hide() { visible = false; }
function reset() { if (controls) controls.reset(); }

window.pgs3d = { show, hide, reset };

// Placeholder to prevent crashing if functions aren't fully implemented
function rebuildEditorVisuals() {}