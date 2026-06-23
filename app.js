let locations = [];
let routes = [];
let graph = {};
let mode = "visitor";
let selectedNode = null;

const byId = (id) => document.getElementById(id);

async function init() {
  locations = await fetch("data/locations.json").then(r => r.json());
  routes = await fetch("data/routes.json").then(r => r.json());
  buildGraph();
  populateSelects();
  drawNetwork();
  drawNodes();
  byId("routeBtn").addEventListener("click", generateRoute);
  document.querySelectorAll(".mode").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      mode = btn.dataset.mode;
      setModeDefaults();
    });
  });
  setModeDefaults();
}

function buildGraph() {
  graph = {};
  locations.forEach(l => graph[l.id] = []);
  routes.forEach(([a,b,w]) => {
    graph[a].push({id:b, weight:w});
    graph[b].push({id:a, weight:w});
  });
}

function loc(id) { return locations.find(l => l.id === id); }

function populateSelects() {
  const start = byId("startSelect");
  const end = byId("endSelect");
  locations.forEach(l => {
    const o1 = new Option(l.name, l.id);
    const o2 = new Option(l.name, l.id);
    start.add(o1);
    end.add(o2);
  });
}

function setModeDefaults() {
  if (mode === "visitor") {
    byId("startSelect").value = "main_guard_house";
    byId("endSelect").value = "visitor_badging";
    byId("subtitle").textContent = "Visitor-safe guided routing";
  } else if (mode === "employee") {
    byId("startSelect").value = "main_guard_house";
    byId("endSelect").value = "formation";
    byId("subtitle").textContent = "Employee pedestrian movement";
  } else {
    byId("startSelect").value = "center_junction";
    byId("endSelect").value = "muster_center";
    byId("subtitle").textContent = "Emergency reference routing";
  }
  generateRoute();
}

function drawNetwork() {
  const layer = byId("networkLayer");
  layer.innerHTML = "";
  routes.forEach(([a,b]) => {
    const A = loc(a), B = loc(b);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", A.x); line.setAttribute("y1", A.y);
    line.setAttribute("x2", B.x); line.setAttribute("y2", B.y);
    line.setAttribute("class", "network");
    layer.appendChild(line);
  });
}

function drawNodes() {
  const layer = byId("nodeLayer");
  layer.innerHTML = "";
  locations.forEach(l => {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", `node ${l.type}`);
    g.setAttribute("transform", `translate(${l.x},${l.y})`);
    g.dataset.id = l.id;

    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("class", "ring");
    ring.setAttribute("r", "0");

    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("class", "dot");
    c.setAttribute("r", "9");

    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", "14");
    label.setAttribute("y", "-12");
    label.textContent = shortLabel(l.name);

    g.appendChild(ring);
    g.appendChild(c);
    g.appendChild(label);
    g.addEventListener("click", () => showDestination(l.id));
    layer.appendChild(g);
  });
}

function shortLabel(name) {
  return name
    .replace("Plant Entry - ","")
    .replace("Trade Entry - ","")
    .replace(" / Controlled Entry","")
    .replace(" / Escort Checkpoint","");
}

function dijkstra(start, end) {
  const dist = {}, prev = {}, q = new Set(Object.keys(graph));
  Object.keys(graph).forEach(k => dist[k] = Infinity);
  dist[start] = 0;
  while (q.size) {
    let u = [...q].sort((a,b) => dist[a]-dist[b])[0];
    q.delete(u);
    if (u === end) break;
    for (const n of graph[u]) {
      const alt = dist[u] + n.weight;
      if (alt < dist[n.id]) {
        dist[n.id] = alt;
        prev[n.id] = u;
      }
    }
  }
  const path = [];
  let u = end;
  while (u) { path.unshift(u); u = prev[u]; }
  return {path, distance: dist[end]};
}

function generateRoute() {
  const start = byId("startSelect").value;
  const end = byId("endSelect").value;
  if (start === end) return;
  const result = dijkstra(start, end);
  drawRoute(result.path);
  updateRouteCard(result);
  showDestination(end);
}

function drawRoute(path) {
  const layer = byId("routeLayer");
  layer.innerHTML = "";
  const points = path.map(id => `${loc(id).x},${loc(id).y}`).join(" ");
  const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  pl.setAttribute("points", points);
  pl.setAttribute("class", "route");
  pl.setAttribute("marker-end", "url(#arrow)");
  layer.appendChild(pl);

  document.querySelectorAll(".node").forEach(n => n.classList.remove("selected"));
  path.forEach(id => {
    const node = document.querySelector(`.node[data-id="${id}"]`);
    if (node) node.classList.add("selected");
  });
}

function updateRouteCard(result) {
  const feet = Math.round(result.distance * 1.7);
  const mins = Math.max(1, Math.round(feet / 250));
  byId("routeStatus").textContent = "AUTHORIZED";
  byId("distanceMetric").textContent = `${feet} ft`;
  byId("timeMetric").textContent = `${mins} min`;

  const steps = byId("steps");
  steps.innerHTML = "";
  result.path.forEach((id, i) => {
    const l = loc(id);
    const div = document.createElement("div");
    div.className = "step";
    div.innerHTML = `<strong>${i+1}. ${l.name}</strong><br><span>${l.description}</span>`;
    steps.appendChild(div);
  });
}

function showDestination(id) {
  selectedNode = id;
  const l = loc(id);
  byId("drawerTitle").textContent = l.name;
  byId("drawerDesc").textContent = l.description;
  byId("drawerAccess").textContent = l.access;
  byId("endSelect").value = id;
}

init();