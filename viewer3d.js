import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

let scene, camera, renderer, labelRenderer, controls, model, initialized = false;

// 1. ALL FUNCTIONS DECLARED FIRST
function setStatus(msg, { error = false, hidden = false } = {}) {
    const status = document.getElementById("threeStatus");
    if (!status) return;
    status.style.display = hidden ? "none" : "block";
    const span = status.querySelector("span:last-child");
    if (span) span.textContent = msg;
}
function toggleWalkPreview() {}
function toggleRouteEditor() {}
function undoEditorNode() {}
function startEditorSegment() {}
function deleteSelectedEditorNode() {}
function clearEditorDraft() {}
function saveEditorDraft() {}
function exportEditorDraft() {}
function selectLabelTarget() {}
function startLabelPlacement() {}
function removeLabelOverride() {}
function saveLabelOverrides() {}
function exportLabelOverrides() {}
function selectDestinationSource() {}
function startDestinationPlacement() {}
function removeDestinationDraft() {}
function exportDestinationDrafts() {}

// 2. INITIALIZATION
function initialize() {
    if (initialized) return;
    initialized = true;
    const host = document.getElementById("threeCanvas");
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071629);
    camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, .1, 10000);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    host.appendChild(renderer.domElement);
    
    // SAFE LISTENERS
    const listeners = [
        { id: "threeWalkToggle", event: "click", fn: toggleWalkPreview },
        { id: "threeEditToggle", event: "click", fn: toggleRouteEditor }
    ];
    listeners.forEach(l => { const el = document.getElementById(l.id); if (el) el.addEventListener(l.event, l.fn); });
}

async function loadModel() {
    if (model) return;
    try {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync("assets/models/site_mobile.glb");
        model = gltf.scene;
        scene.add(model);
        setStatus("Ready", { hidden: true });
    } catch (e) { setStatus("Load Error: " + e.message, { error: true }); }
}

function animate() { requestAnimationFrame(animate); renderer.render(scene, camera); }
function show() { initialize(); loadModel(); animate(); }
function hide() {}
function reset() {}

window.pgs3d = { show, hide, reset };