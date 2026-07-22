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

    // Wire UI Elements safely
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

// ... (Rest of your existing viewer3d.js functions)