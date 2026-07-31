/* =========================================================
   WAYPOINT — frontend app
   Talks to the backend API (see /backend) for auth, trips,
   places, routing, rides, and sharing. Geocoding/route-line
   drawing for the map still calls OSM/OSRM directly from the
   browser (no key required, fine to call client-side).
   ========================================================= */

const API = window.WAYPOINT_CONFIG.API_BASE_URL;
const PACE_STOPS = { relaxed: 3, moderate: 5, packed: 7 };
const MEMBER_COLORS = ['#E2654A','#3F6B53','#C99A3B','#5B3FA3','#2B6E91','#A03E78'];

let token = localStorage.getItem('waypoint_token');
let currentUser = JSON.parse(localStorage.getItem('waypoint_user') || 'null');
let trip = null;       // full active trip object from GET /api/trips/:id
let myTrips = [];      // list for the trip switcher
let map, hotelMarker, placeMarkers = [], routeLine;
let lastItinerary = null;

// ---------------- API helper ----------------
async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---------------- Auth ----------------
let authMode = 'login';
const authMask = document.getElementById('authMask');
const authNameInput = document.getElementById('authName');

document.getElementById('authToggle').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'signup' : 'login';
  document.getElementById('authTitle').textContent = authMode === 'login' ? 'Welcome back' : 'Create your account';
  document.getElementById('authSub').textContent = authMode === 'login' ? 'Sign in to plan your trip.' : 'Takes 10 seconds — no credit card.';
  document.getElementById('authSubmit').textContent = authMode === 'login' ? 'Sign in' : 'Create account';
  document.getElementById('authToggle').parentElement.firstChild.textContent = authMode === 'login' ? 'No account? ' : 'Already have one? ';
  document.getElementById('authToggle').textContent = authMode === 'login' ? 'Create one' : 'Sign in';
  authNameInput.style.display = authMode === 'signup' ? 'block' : 'none';
});

document.getElementById('authSubmit').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const displayName = authNameInput.value.trim();
  const errEl = document.getElementById('authErr');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Enter an email and password.'; return; }
  try {
    const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/signup';
    const body = authMode === 'login' ? { email, password } : { email, password, displayName: displayName || 'Traveler' };
    const data = await api(path, { method: 'POST', body });
    token = data.token; currentUser = data.user;
    localStorage.setItem('waypoint_token', token);
    localStorage.setItem('waypoint_user', JSON.stringify(currentUser));
    await boot();
  } catch (e) { errEl.textContent = e.message; }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('waypoint_token'); localStorage.removeItem('waypoint_user');
  token = null; currentUser = null; trip = null;
  document.getElementById('app').style.display = 'none';
  authMask.style.display = 'flex';
});

// ---------------- Map ----------------
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([52.3676, 4.9041], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}
function numIcon(n) { return L.divIcon({ className:'', html:`<div class="num-pin"><span>${n}</span></div>`, iconSize:[26,26], iconAnchor:[13,26] }); }
function hotelIcon() { return L.divIcon({ className:'', html:`<div class="hotel-pin">🏨</div>`, iconSize:[30,30], iconAnchor:[15,15] }); }

// ---------------- auto-populate POIs from Overpass ----------------
let poiMarkers = [];
let poiLayer = null;
let poiCategoryFilters = { restaurant: true, bar: true, museum: true, landmark: true, shopping: true };

const POI_CATEGORIES = {
  restaurant: { tags: [['amenity','restaurant'],['amenity','cafe'],['amenity','fast_food']], color:'#FF6B35', emoji:'🍽️' },
  bar: { tags: [['amenity','bar'],['amenity','pub'],['amenity','nightclub']], color:'#7C3AED', emoji:'🍸' },
  museum: { tags: [['tourism','museum'],['tourism','gallery'],['tourism','artwork']], color:'#2563EB', emoji:'🏛️' },
  landmark: { tags: [['tourism','attraction'],['historic','monument'],['historic','memorial'],['tourism','viewpoint']], color:'#DC2626', emoji:'📍' },
  shopping: { tags: [['shop','mall'],['shop','department_store'],['shop','boutique'],['amenity','marketplace']], color:'#DB2777', emoji:'🛍️' },
};

async function loadCityPOIs(lat, lng, radiusM = 3000) {
  clearPOIMarkers();
  const queries = Object.entries(POI_CATEGORIES).map(([cat, cfg]) => {
    return cfg.tags.map(([k,v]) => `node["${k}"="${v}"](around:${radiusM},${lat},${lng});`).join('');
  }).join('');

  const overpassQuery = `[out:json][timeout:20];(${queries});out body;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(overpassQuery)
    });
    const data = await res.json();
    renderPOIMarkers(data.elements || []);
  } catch(e) { console.warn('POI load failed:', e.message); }
}

function getPOICategory(el) {
  const tags = el.tags || {};
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' || tags.amenity === 'fast_food') return 'restaurant';
  if (tags.amenity === 'bar' || tags.amenity === 'pub' || tags.amenity === 'nightclub') return 'bar';
  if (tags.tourism === 'museum' || tags.tourism === 'gallery') return 'museum';
  if (tags.tourism === 'attraction' || tags.historic) return 'landmark';
  if (tags.shop) return 'shopping';
  return 'landmark';
}

function renderPOIMarkers(elements) {
  clearPOIMarkers();
  const seen = new Set();
  elements.forEach(el => {
    if (!el.lat || !el.lon) return;
    const name = el.tags?.name;
    if (!name) return; // skip unnamed places
    const key = `${name}|${Math.round(el.lat*100)}|${Math.round(el.lon*100)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const cat = getPOICategory(el);
    const cfg = POI_CATEGORIES[cat];
    const icon = L.divIcon({
      className: 'poi-icon',
      html: `<div class="poi-pin" style="background:${cfg.color}" title="${name}">${cfg.emoji}</div>`,
      iconSize: [30,30], iconAnchor: [15,15]
    });

    const marker = L.marker([el.lat, el.lon], { icon, opacity: 0.85 })
      .bindPopup(`
        <div style="min-width:180px;">
          <strong>${name}</strong><br>
          <span style="font-size:11px;color:#666;">${cat}</span><br>
          <button onclick="addPOIToTrip('${name.replace(/'/g,"\'")}','${cat}',${el.lat},${el.lon})"
            style="margin-top:6px;padding:4px 10px;background:#6366F1;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;width:100%;">
            + Add to my trip
          </button>
        </div>
      `);
    marker._poiCat = cat;
    if (poiCategoryFilters[cat]) marker.addTo(map);
    poiMarkers.push(marker);
  });
  if (poiMarkers.length > 0) {
    document.getElementById('poiToggleBtn') && (document.getElementById('poiToggleBtn').textContent = `📍 ${poiMarkers.length} nearby places`);
  }
}

function clearPOIMarkers() {
  poiMarkers.forEach(m => map.removeLayer(m));
  poiMarkers = [];
}

function togglePOICategory(cat) {
  poiCategoryFilters[cat] = !poiCategoryFilters[cat];
  poiMarkers.forEach(m => {
    if (m._poiCat === cat) {
      if (poiCategoryFilters[cat]) { m.addTo(map); }
      else { map.removeLayer(m); }
    }
  });
  // Update toggle button appearance
  const btn = document.querySelector(`.poi-cat-btn[data-cat="${cat}"]`);
  if (btn) btn.classList.toggle('active', poiCategoryFilters[cat]);
  // Update count
  const visible = poiMarkers.filter(m => poiCategoryFilters[m._poiCat]).length;
  const toggleBtn = document.getElementById('poiToggleBtn');
  if (toggleBtn) toggleBtn.textContent = `📍 ${visible} nearby`;
}
window.togglePOICategory = togglePOICategory;

async function addPOIToTrip(name, category, lat, lng) {
  try {
    const place = await api(`/api/trips/${trip.id}/places`, {
      method: 'POST',
      body: { query: `${name}, ${trip.destination_city || ''}`, name, category, visitDurationMin: 60, estimatedCostCents: 0 }
    });
    trip.places = [...(trip.places || []), place];
    renderPlaces(); redrawMarkers(); renderBudget();
    map.closePopup();
    document.querySelector('.tab[data-tab="places"]').click();
  } catch(e) { alert('Could not add place: ' + e.message); }
}
window.addPOIToTrip = addPOIToTrip; // expose for popup onclick

function redrawMarkersInOrder() {
  // Redraw markers using current trip.places order (for manual mode)
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  (trip.places || []).forEach((p, i) => {
    if (!p.lat || !p.lng) return;
    const icon = L.divIcon({ className:'place-icon', html:`<div class="pin-num">${i+1}</div>`, iconSize:[28,28], iconAnchor:[14,14] });
    const m = L.marker([p.lat, p.lng], { icon }).addTo(map).bindPopup(`<b>${p.name}</b><br>${p.category||''}`);
    placeMarkers.push(m);
  });
}

function redrawMarkers() {
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  (trip.places || []).forEach((p, i) => {
    // In manual order mode, use array index; otherwise use route_position from DB
    const order = manualOrder ? (i + 1) : ((p.route_position) ? p.route_position : i + 1);
    const m = L.marker([p.lat, p.lng], { icon: numIcon(order) }).addTo(map);
    m.bindPopup(`<b>${escapeHtml(p.name)}</b><br>${p.category}<br>${escapeHtml(p.address || '')}`);
    placeMarkers.push(m);
  });
  document.getElementById('mapStatPlaces').textContent = (trip.places || []).length + ((trip.places || []).length === 1 ? ' place' : ' places');
}
function drawRouteLine(coordsLatLng) {
  if (routeLine) map.removeLayer(routeLine);
  if (!coordsLatLng || coordsLatLng.length < 2) return;
  routeLine = L.polyline(coordsLatLng, { color:'#E2654A', weight:3, dashArray:'1,8', lineCap:'round' }).addTo(map);
}
function fitAll() {
  const pts = [];
  const base = primaryBase();
  if (base) pts.push([base.lat, base.lng]);
  (trip.places || []).forEach(p => pts.push([p.lat, p.lng]));
  if (pts.length) map.fitBounds(pts, { padding:[60,60] });
}
function primaryBase() { return (trip.bases || []).find(b => b.is_primary) || (trip.bases || [])[0] || null; }

async function ensureBases() {
  const fresh = await api(`/api/trips/${trip.id}`);
  trip.bases = fresh.bases || [];
}

// ---------------- client-side geocoding / OSRM geometry (for the visual route line only) ----------------
async function osrmRouteGeometry(points, profile) {
  try {
    const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/${profile}/${coordStr}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok') return data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
  } catch (e) { /* fall through */ }
  return points.map(p => [p.lat, p.lng]);
}

// ---------------- helpers ----------------
function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function catTagHtml(cat){ return `<span class="tag ${cat||'other'}">${cat||'other'}</span>`; }
function fmtMoney(cents){ return '$' + ((cents||0)/100).toFixed(0); }

// ---------------- tabs ----------------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tabcontent').forEach(c => c.hidden = true);
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).hidden = false;
    if (btn.dataset.tab === 'group') { startChat(); }
    else { stopChat(); }
  });
});

// ---------------- autocomplete ----------------
let acDebounceTimer = null;

async function fetchSuggestions(query, type = 'all') {
  if (!query || query.length < 2) return [];
  try {
    // For cities only, filter by type
    const typeParam = type === 'city' ? '&layer=city&layer=district&layer=county' : '';
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6${typeParam}`);
    const data = await res.json();
    return (data.features || []).map(f => {
      const p = f.properties;
      const parts = [p.name, p.city || p.district, p.state, p.country].filter(Boolean);
      const label = [...new Set(parts)].join(', ');
      return { label, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], name: p.name };
    }).filter((s, i, arr) => arr.findIndex(x => x.label === s.label) === i); // dedupe
  } catch(e) { return []; }
}

function setupAutocomplete(inputId, listId, onSelect, type = 'all') {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  input.addEventListener('input', () => {
    clearTimeout(acDebounceTimer);
    const q = input.value.trim();
    if (!q || q.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
    acDebounceTimer = setTimeout(async () => {
      const suggestions = await fetchSuggestions(q, type);
      if (!suggestions.length) { list.innerHTML = ''; list.hidden = true; return; }
      list.innerHTML = suggestions.map((s, i) =>
        `<div class="ac-item" data-idx="${i}">${s.label}</div>`
      ).join('');
      list.hidden = false;
      list._suggestions = suggestions;
      list.querySelectorAll('.ac-item').forEach(item => {
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          const s = list._suggestions[parseInt(item.dataset.idx)];
          input.value = s.label;
          list.innerHTML = ''; list.hidden = true;
          onSelect(s);
        });
      });
    }, 250);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { list.innerHTML = ''; list.hidden = true; }, 200);
  });

  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.ac-item');
    const active = list.querySelector('.ac-item.focused');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (next) { active && active.classList.remove('focused'); next.classList.add('focused'); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active ? active.previousElementSibling : items[items.length - 1];
      if (prev) { active && active.classList.remove('focused'); prev.classList.add('focused'); }
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      active.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      list.innerHTML = ''; list.hidden = true;
    }
  });
}

// ---------------- setup tab ----------------
document.querySelectorAll('#pacePills .pill').forEach(p => {
  p.addEventListener('click', async () => {
    document.querySelectorAll('#pacePills .pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    if (!trip) return;
    await api(`/api/trips/${trip.id}`, { method:'PATCH', body:{ pace: p.dataset.pace } });
    trip.pace = p.dataset.pace;
  });
});
document.querySelectorAll('#modePills .pill').forEach(p => {
  p.addEventListener('click', async () => {
    document.querySelectorAll('#modePills .pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    if (!trip) return;
    await api(`/api/trips/${trip.id}`, { method:'PATCH', body:{ transport_mode: p.dataset.mode } });
    trip.transport_mode = p.dataset.mode;
  });
});

document.getElementById('saveSetupBtn').addEventListener('click', async () => {
  const body = {
    name: document.getElementById('tripNameInput').value,
    destination_city: document.getElementById('cityInput').value,
    start_date: document.getElementById('startDate').value || null,
    end_date: document.getElementById('endDate').value || null,
    emergency_number: document.getElementById('emergencyNum').value,
    embassy_info: document.getElementById('embassyInfo').value,
  };
  const updated = await api(`/api/trips/${trip.id}`, { method:'PATCH', body });
  Object.assign(trip, updated);
  populateTripSwitcher();
  // Auto-load nearby POIs when destination is set
  if (updated.destination_lat && updated.destination_lng) {
    loadCityPOIs(updated.destination_lat, updated.destination_lng, 3000);
    map.setView([updated.destination_lat, updated.destination_lng], 14);
  }
});

document.getElementById('deleteTripBtn').addEventListener('click', async () => {
  if (!confirm(`Delete "${trip.name}"? This cannot be undone.`)) return;
  try {
    await api(`/api/trips/${trip.id}`, { method: 'DELETE' });
    // Remove from local list and reload
    myTrips = myTrips.filter(t => t.id !== trip.id);
    if (myTrips.length) {
      await loadTrip(myTrips[0].id);
    } else {
      await promptNewTrip();
    }
  } catch(e) { alert('Could not delete trip: ' + e.message); }
});

document.getElementById('hotelSearchBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('hotelStatus');
  const name = document.getElementById('hotelInput').value.trim();
  if (!name) return;
  statusEl.textContent = 'Locating…';
  try {
    const base = await api(`/api/trips/${trip.id}/base`, { method:'POST', body:{ name, address: name + ', ' + document.getElementById('cityInput').value, checkIn: document.getElementById('startDate').value || null, checkOut: document.getElementById('endDate').value || null } });
    trip.bases = [base, ...(trip.bases || []).filter(b => !b.is_primary)];
    if (hotelMarker) map.removeLayer(hotelMarker);
    hotelMarker = L.marker([base.lat, base.lng], { icon: hotelIcon() }).addTo(map).bindPopup('<b>🏨 ' + escapeHtml(name) + '</b><br>Home base');
    map.setView([base.lat, base.lng], 14);
    statusEl.textContent = 'Located: ' + base.address;
  } catch (e) { statusEl.textContent = e.message; }
});

// ---------------- places tab ----------------
let activeCategory = 'landmark';
document.querySelectorAll('#categoryPills .pill').forEach(p => {
  p.addEventListener('click', () => {
    // Toggle this pill on/off (multi-select for POI filter)
    const cat = p.dataset.cat;
    const isActive = p.classList.contains('active');

    if (isActive) {
      // Only deactivate if at least one other pill stays active
      const activePills = document.querySelectorAll('#categoryPills .pill.active');
      if (activePills.length <= 1) return; // keep at least one
      p.classList.remove('active');
      poiCategoryFilters[cat] = false;
    } else {
      p.classList.add('active');
      poiCategoryFilters[cat] = true;
    }

    // Update POI markers on map
    poiMarkers.forEach(m => {
      if (m._poiCat === cat) {
        if (poiCategoryFilters[cat]) { m.addTo(map); }
        else { map.removeLayer(m); }
      }
    });

    // Set activeCategory to the last activated pill
    activeCategory = cat;
  });
});

document.getElementById('addPlaceBtn').addEventListener('click', async () => {
  const q = document.getElementById('placeSearch').value.trim();
  const statusEl = document.getElementById('placeSearchStatus');
  if (!q) { statusEl.textContent = 'Enter a place name first.'; return; }
  statusEl.textContent = 'Searching…';
  try {
    const cityCtx = document.getElementById('cityInput').value || trip.destination_city || '';
    const place = await api(`/api/trips/${trip.id}/places`, {
      method:'POST',
      body: {
        query: q + ', ' + cityCtx,
        name: q,
        category: activeCategory,
        visitDurationMin: parseInt(document.getElementById('placeDuration').value) || 60,
        estimatedCostCents: Math.round((parseFloat(document.getElementById('placeCost').value) || 0) * 100),
        notes: document.getElementById('placeNotes').value,
      }
    });
    trip.places = [...(trip.places || []), place];
    document.getElementById('placeSearch').value = ''; document.getElementById('placeNotes').value = '';
    statusEl.textContent = 'Added: ' + place.address;
    renderPlaces(); redrawMarkers(); fitAll(); renderBudget();
  } catch (e) { statusEl.textContent = e.message; }
});

let manualOrder = false;
let dragSrcIdx = null;

function renderPlaces() {
  const list = document.getElementById('placeList');
  document.getElementById('placeCount').textContent = (trip.places || []).length;
  if (!trip.places || !trip.places.length) { list.innerHTML = '<div class="empty">No places yet. Search above, or add a Celebrity Pick.</div>'; return; }

  // Order toggle UI
  const toggleHtml = `
    <div class="order-toggle">
      <span>Route order:</span>
      <button class="toggle-btn ${!manualOrder ? 'active' : ''}" id="useOptimized">⚡ Optimized</button>
      <button class="toggle-btn ${manualOrder ? 'active' : ''}" id="useManual">✋ My Order</button>
    </div>`;

  list.innerHTML = toggleHtml + trip.places.map((p, i) => `
    <div class="placecard ${manualOrder ? 'draggable' : ''}" draggable="${manualOrder}" data-idx="${i}" data-id="${p.id}">
      <div class="drag-handle ${manualOrder ? '' : 'hidden'}">⠿</div>
      <div class="num">${i+1}</div>
      <h4>${escapeHtml(p.name)}</h4>
      <div class="meta">${catTagHtml(p.category)} <span>${fmtMoney(p.estimated_cost_cents)} · ${p.visit_duration_min||60}min</span></div>
      ${p.notes ? `<div class="hint">${escapeHtml(p.notes)}</div>` : ''}
      ${reservationBtnsHtml(p.name, trip.destination_city, p.category)}
      <div class="time-row">
        <label class="time-label">Day</label>
        <input class="time-day-input" type="number" min="1" max="30" value="${p.scheduled_day || 1}" data-placeid="${p.id}" data-field="day">
        <label class="time-label">Time</label>
        <input class="time-input" type="time" value="${p.scheduled_time ? p.scheduled_time.slice(0,5) : ''}" data-placeid="${p.id}" data-field="time" placeholder="--:--">
      </div>
      <div class="actions"><button class="iconbtn" data-remove="${p.id}">Remove</button></div>
    </div>`).join('');

  // Toggle handlers
  document.getElementById('useOptimized').addEventListener('click', async () => {
    manualOrder = false;
    // Re-fetch places in DB order (route_position from last optimization)
    try { trip.places = await api(`/api/trips/${trip.id}/places`); } catch(e) {}
    renderPlaces(); redrawMarkers();
  });
  document.getElementById('useManual').addEventListener('click', () => { manualOrder = true; renderPlaces(); });

  // Remove handlers
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/trips/${trip.id}/places/${btn.dataset.remove}`, { method:'DELETE' });
      trip.places = trip.places.filter(p => p.id !== btn.dataset.remove);
      renderPlaces(); redrawMarkers(); renderBudget();
    });
  });

  // Time/day pickers — save on change
  list.querySelectorAll('.time-input, .time-day-input').forEach(input => {
    input.addEventListener('change', async () => {
      const placeId = input.dataset.placeid;
      const field = input.dataset.field;
      const place = trip.places.find(p => p.id === placeId);
      if (!place) return;
      if (field === 'time') {
        place.scheduled_time = input.value || null;
        await api(`/api/trips/${trip.id}/places/${placeId}`, { method:'PATCH', body:{ scheduled_time: input.value || null } });
      } else if (field === 'day') {
        place.scheduled_day = parseInt(input.value) || 1;
        await api(`/api/trips/${trip.id}/places/${placeId}`, { method:'PATCH', body:{ scheduled_day: parseInt(input.value) || 1 } });
      }
    });
  });

  // Drag-and-drop handlers
  if (manualOrder) {
    list.querySelectorAll('.placecard[draggable="true"]').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragSrcIdx = parseInt(card.dataset.idx);
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const destIdx = parseInt(card.dataset.idx);
        if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
        // Reorder trip.places array
        const moved = trip.places.splice(dragSrcIdx, 1)[0];
        trip.places.splice(destIdx, 0, moved);
        dragSrcIdx = null;
        // Save new order to backend
        try {
          await api(`/api/trips/${trip.id}/places/reorder`, {
            method: 'POST',
            body: { order: trip.places.map((p, i) => ({ id: p.id, position: i + 1 })) }
          });
        } catch (e) { console.warn('Could not save order:', e.message); }
        renderPlaces(); redrawMarkers();
      });
    });
  }
}

// ---------------- influencer / celebrity guides tab ----------------
let allGuides = [];
let guideFilter = { person: '', city: '', category: '' };

async function loadCelebrityPicks() {
  const list = document.getElementById('celebList');
  try {
    allGuides = await api('/api/celebrity-picks');

    // Auto-filter by destination city if trip has one
    if (trip && trip.destination_city && !guideFilter.city) {
      const cityName = trip.destination_city.split(',')[0].trim();
      guideFilter.city = cityName;
    }

    renderGuideFilters();
    renderGuides();
  } catch (e) {
    list.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function renderGuideFilters() {
  const list = document.getElementById('celebList');

  // Build unique person and category lists
  const people = [...new Set(allGuides.map(g => g.celebrity_name))].sort();
  const categories = [...new Set(allGuides.map(g => g.category).filter(Boolean))].sort();

  const filterHtml = `
    <div class="guide-filters">
      <input class="guide-search" id="guideCityFilter" type="text" placeholder="🌍 Filter by city..." value="${escapeHtml(guideFilter.city)}">
      <select id="guidePersonFilter" class="guide-select">
        <option value="">All guides</option>
        ${people.map(p => `<option value="${escapeHtml(p)}" ${guideFilter.person === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      <select id="guideCatFilter" class="guide-select">
        <option value="">All types</option>
        ${categories.map(c => `<option value="${escapeHtml(c)}" ${guideFilter.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <button class="iconbtn" id="guideClearBtn">Clear</button>
    </div>
    <div id="guideCards"></div>`;

  list.innerHTML = filterHtml;

  document.getElementById('guideCityFilter').addEventListener('input', e => { guideFilter.city = e.target.value; renderGuides(); });
  document.getElementById('guidePersonFilter').addEventListener('change', e => { guideFilter.person = e.target.value; renderGuides(); });
  document.getElementById('guideCatFilter').addEventListener('change', e => { guideFilter.category = e.target.value; renderGuides(); });
  document.getElementById('guideClearBtn').addEventListener('click', () => {
    guideFilter = { person: '', city: '', category: '' };
    document.getElementById('guideCityFilter').value = '';
    document.getElementById('guidePersonFilter').value = '';
    document.getElementById('guideCatFilter').value = '';
    renderGuides();
  });
}

function renderGuides() {
  const cards = document.getElementById('guideCards');
  if (!cards) return;

  let filtered = allGuides.filter(g => {
    const cityMatch = !guideFilter.city || g.city.toLowerCase().includes(guideFilter.city.toLowerCase()) || (g.country && g.country.toLowerCase().includes(guideFilter.city.toLowerCase()));
    const personMatch = !guideFilter.person || g.celebrity_name === guideFilter.person;
    const catMatch = !guideFilter.category || g.category === guideFilter.category;
    return cityMatch && personMatch && catMatch;
  });

  // Group by celebrity
  const grouped = {};
  filtered.forEach(g => {
    if (!grouped[g.celebrity_name]) grouped[g.celebrity_name] = [];
    grouped[g.celebrity_name].push(g);
  });

  if (!filtered.length) {
    cards.innerHTML = '<div class="empty">No guides match your filters. Try a different city or clear filters.</div>';
    return;
  }

  cards.innerHTML = Object.entries(grouped).map(([name, picks]) => `
    <div class="influencer-section">
      <div class="influencer-header">
        <div class="influencer-avatar">${name.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
        <div>
          <div class="influencer-name">${escapeHtml(name)}</div>
          <div class="influencer-count">${picks.length} pick${picks.length>1?'s':''}</div>
        </div>
      </div>
      <div class="guide-pick-list">
        ${picks.map((g, i) => `
          <div class="guide-pick-card" data-gidx="${allGuides.indexOf(g)}">
            <div class="guide-pick-top">
              <div>
                <div class="guide-pick-name">${escapeHtml(g.place_name)}</div>
                <div class="guide-pick-meta">${escapeHtml(g.city)}, ${escapeHtml(g.country||'')} ${catTagHtml(g.category)}</div>
              </div>
              <button class="btn btn-gold btn-small add-guide-btn" data-gidx="${allGuides.indexOf(g)}">+ Add</button>
            </div>
            ${g.note ? `<p class="guide-pick-note">${escapeHtml(g.note)}</p>` : ''}
          </div>`).join('')}
      </div>
    </div>`).join('');

  cards.querySelectorAll('.add-guide-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const g = allGuides[parseInt(btn.dataset.gidx)];
      btn.textContent = '…';
      btn.disabled = true;
      try {
        const place = await api(`/api/trips/${trip.id}/places`, {
          method:'POST',
          body: { query: `${g.place_name}, ${g.city}, ${g.country||''}`, name: g.place_name, category: g.category || 'restaurant', notes: g.note, visitDurationMin: 75, estimatedCostCents: 0, celebrityPickId: g.id }
        });
        trip.places = [...(trip.places || []), place];
        renderPlaces(); redrawMarkers(); fitAll(); renderBudget();
        btn.textContent = '✅ Added';
        btn.style.background = 'var(--forest)';
      } catch(e) {
        btn.textContent = '+ Add';
        btn.disabled = false;
        alert('Could not add place: ' + e.message);
      }
    });
  });
}

// ---------------- itinerary / routing ----------------
document.getElementById('optimizeBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('optimizeStatus');
  await ensureBases();
  const base = primaryBase();
  if (!base) { statusEl.textContent = 'Set your hotel location in Setup first.'; return; }
  if (!trip.places || !trip.places.length) { statusEl.textContent = 'Add at least one place first.'; return; }

  if (manualOrder) {
    // Use the user's manual drag-and-drop order — no backend calculation
    statusEl.textContent = 'Building itinerary in your order…';
    try {
      const pace = trip.pace || 5;
      const days = [];
      let dayNum = 1, stops = [];
      trip.places.forEach((p, i) => {
        stops.push({ ...p, legDistanceM: null, legDurationS: null });
        if (stops.length >= pace || i === trip.places.length - 1) {
          days.push({ day: dayNum++, stops });
          stops = [];
        }
      });
      const totalStops = trip.places.length;
      const result = { days, totalDistanceM: 0, totalDurationS: 0, routeSource: 'manual' };
      lastItinerary = result;
      document.getElementById('mapStatDistance').textContent = `${totalStops} stops`;
      document.getElementById('mapStatTime').textContent = 'Custom order';
      redrawMarkers(); // uses manualOrder flag to number pins correctly
      const profile = trip.transport_mode === 'walking' ? 'foot' : 'driving';
      const geomPoints = [{ lat: base.lat, lng: base.lng }, ...trip.places.map(p => ({ lat: p.lat, lng: p.lng }))];
      const geom = await osrmRouteGeometry(geomPoints, profile);
      drawRouteLine(geom);
      renderItinerary(result, base);
      statusEl.textContent = `Custom order applied — ${totalStops} stops in your sequence.`;
    } catch (e) { statusEl.textContent = e.message; }
    return;
  }

  // ⏰ TIME-BASED SCHEDULING (default when not in manual order)
  statusEl.textContent = 'Building your day schedule…';
  try {
    // Always re-fetch fresh data so latest day/time edits are included
    trip.places = await api(`/api/trips/${trip.id}/places`);
    const hasTimedPlaces = trip.places.some(p => p.scheduled_time);
    const profile = trip.transport_mode === 'walking' ? 'foot' : 'driving';

    if (hasTimedPlaces) {
      // Sort by day then scheduled_time
      const sorted = [...trip.places].sort((a, b) => {
        const dayA = a.scheduled_day || 1, dayB = b.scheduled_day || 1;
        if (dayA !== dayB) return dayA - dayB;
        const tA = a.scheduled_time || '23:59', tB = b.scheduled_time || '23:59';
        return tA.localeCompare(tB);
      });

      // Group by day
      const dayMap = {};
      sorted.forEach(p => {
        const d = p.scheduled_day || 1;
        if (!dayMap[d]) dayMap[d] = [];
        dayMap[d].push(p);
      });

      const days = [];
      let totalDurationS = 0;
      const conflicts = [];
      const allSorted = [];

      for (const [dayNum, places] of Object.entries(dayMap)) {
        const stops = [];
        let prevLat = base.lat, prevLng = base.lng;
        let prevEndTime = null;

        for (const p of places) {
          let legDurationS = null;
          try {
            const r = await fetch(`https://router.project-osrm.org/route/v1/${profile}/${prevLng},${prevLat};${p.lng},${p.lat}?overview=false`);
            const d = await r.json();
            if (d.code === 'Ok') legDurationS = d.routes[0].duration;
          } catch(e) {}

          // Check for timing conflicts
          if (prevEndTime && p.scheduled_time && legDurationS) {
            const gap = timeToMins(p.scheduled_time) - timeToMins(prevEndTime);
            const travelMins = Math.ceil(legDurationS / 60);
            if (travelMins > gap) conflicts.push({ name: p.name, shortfall: travelMins - gap });
          }

          const visitMins = p.visit_duration_min || 60;
          prevEndTime = p.scheduled_time ? addMins(p.scheduled_time, visitMins) : null;
          prevLat = p.lat; prevLng = p.lng;
          if (legDurationS) totalDurationS += legDurationS;

          const stop = { ...p, legDurationS, legDistanceM: null, scheduledTimeDisplay: p.scheduled_time ? formatTime12(p.scheduled_time) : null, hasConflict: conflicts.some(c => c.name === p.name) };
          stops.push(stop);
          allSorted.push(stop);
        }
        days.push({ day: parseInt(dayNum), stops });
      }

      const result = { days, totalDistanceM: 0, totalDurationS, routeSource: 'timed', conflicts };
      lastItinerary = result;
      const numDays = Object.keys(dayMap).length;
      document.getElementById('mapStatDistance').textContent = `${trip.places.length} stops · ${numDays} day${numDays > 1 ? 's' : ''}`;
      document.getElementById('mapStatTime').textContent = Math.round(totalDurationS/60) + ' min travel';
      redrawMarkers();
      const geom = await osrmRouteGeometry([{ lat: base.lat, lng: base.lng }, ...allSorted.map(p => ({ lat: p.lat, lng: p.lng }))], profile);
      drawRouteLine(geom);
      renderItinerary(result, base);

      if (conflicts.length) {
        statusEl.innerHTML = `⚠️ Schedule built — <span style="color:#DC2626;font-weight:700;">${conflicts.length} timing conflict${conflicts.length > 1 ? 's' : ''} detected</span>. Check highlighted stops.`;
      } else {
        statusEl.textContent = `✅ Schedule built — ${trip.places.length} stops across ${numDays} day${numDays > 1 ? 's' : ''}.`;
      }

    } else {
      // No times set — prompt user to add times
      statusEl.innerHTML = `💡 Add times to your places in <b>My Places</b> for a day schedule, or switch to <b>My Order</b> to set a custom sequence.`;
    }
  } catch(e) { statusEl.textContent = e.message; }
});

// ---- Time helpers ----
function timeToMins(t) { if (!t) return 0; const [h,m] = t.split(':').map(Number); return h*60+m; }
function addMins(t, mins) { let total = timeToMins(t) + mins; total = total % (24*60); return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`; }
function formatTime12(t) { if (!t) return ''; const [h,m] = t.split(':').map(Number); const ampm = h>=12?'PM':'AM'; return `${h%12||12}:${String(m).padStart(2,'0')} ${ampm}`; }

const visitedStops = new Set();

function renderItinerary(result, base) {
  let html = '';
  let prevId = 'base';
  let lastStopId = 'base';
  result.days.forEach(day => {
    html += `<div class="daygroup"><div class="dayhead">Day ${day.day} <span class="badge">${day.stops.length} stop${day.stops.length>1?'s':''}</span></div>`;
    day.stops.forEach((stop, si) => {
      const distKm = stop.legDistanceM ? (stop.legDistanceM/1000).toFixed(1) : '—';
      const minutes = stop.legDurationS ? Math.round(stop.legDurationS/60) : '—';
      const visited = visitedStops.has(stop.id);
      const timeDisplay = stop.scheduledTimeDisplay ? `<span class="stop-time">${stop.scheduledTimeDisplay}</span>` : '';
      const conflictClass = stop.hasConflict ? 'conflict' : '';
      html += `<div class="legrow"><span>↳ ${distKm} km</span><span class="dots"></span><span>${minutes} min</span></div>`;
      html += `<div class="stopcard ${visited ? 'visited' : ''} ${conflictClass}" style="margin-bottom:10px;" data-stopid="${stop.id}">
        <div class="stop-header">
          <div class="meta">${catTagHtml(stop.category)} <span>${stop.visit_duration_min||stop.visitDurationMin||60} min visit</span>${timeDisplay}</div>
          <button class="visit-btn ${visited ? 'done' : ''}" data-visit="${stop.id}" title="${visited ? 'Mark unvisited' : 'Mark as visited'}">${visited ? '✅ Visited' : '○ Mark visited'}</button>
        </div>
        ${stop.hasConflict ? `<div class="conflict-warning">⚠️ Not enough travel time — adjust your schedule</div>` : ''}
        <h4>${escapeHtml(stop.name)}</h4>
        <div class="hint">${escapeHtml(stop.address||'')}</div>
        ${reservationBtnsHtml(stop.name, trip.destination_city, stop.category)}
        <button class="uberbtn" data-from="${prevId}" data-to="${stop.id}">🚗 Request Uber here</button>
      </div>`;
      prevId = stop.id;
      lastStopId = stop.id;
    });
    html += `</div>`;
  });

  // Back to hotel button at the bottom
  html += `<div class="back-to-hotel">
    <div class="legrow"><span>↳ Return journey</span><span class="dots"></span><span>Home base</span></div>
    <div class="stopcard" style="margin-bottom:10px;background:var(--parchment);">
      <div class="meta"><span class="tag tag-land">🏨 Hotel</span></div>
      <h4>${escapeHtml(base.name || 'Home Base')}</h4>
      <div class="hint">${escapeHtml(base.address||'')}</div>
      <button class="uberbtn" data-from="${lastStopId}" data-to="base">🚗 Ride back to hotel</button>
    </div>
  </div>`;

  document.getElementById('itineraryOutput').innerHTML = html || '<div class="empty">Nothing to show yet.</div>';

  // Visit toggle handlers
  document.querySelectorAll('.visit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.visit;
      if (visitedStops.has(sid)) { visitedStops.delete(sid); } else { visitedStops.add(sid); }
      renderItinerary(lastItinerary, base);
    });
  });

  // Uber button handlers
  document.querySelectorAll('.uberbtn[data-from]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const win = window.open('', '_blank');
        const ride = await api(`/api/trips/${trip.id}/rides`, { method:'POST', body:{ fromPlaceId: btn.dataset.from, toPlaceId: btn.dataset.to, provider:'uber' } });
        win.location.href = ride.deep_link;
      } catch (e) { alert('Could not start the ride request: ' + e.message); }
    });
  });
}

// ---------------- group chat ----------------
let chatPollInterval = null;
let lastMessageTime = null;
let currentUserId = null;

function startChat() {
  if (chatPollInterval) clearInterval(chatPollInterval);
  loadMessages(true); // full load first
  chatPollInterval = setInterval(() => loadMessages(false), 3000);
}

function stopChat() {
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
}

async function loadMessages(fullLoad = false) {
  try {
    const url = fullLoad || !lastMessageTime
      ? `/api/trips/${trip.id}/messages`
      : `/api/trips/${trip.id}/messages?since=${encodeURIComponent(lastMessageTime)}`;
    const msgs = await api(url);
    if (!msgs.length && !fullLoad) return;

    const box = document.getElementById('chatMessages');
    if (!box) return;

    if (fullLoad) {
      box.innerHTML = msgs.length ? '' : '<div class="chat-empty">No messages yet. Say hello to your group! 👋</div>';
    }

    msgs.forEach(m => {
      if (document.querySelector(`[data-msgid="${m.id}"]`)) return; // skip dupes
      const isMine = m.user_id === currentUserId;
      const time = new Date(m.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const div = document.createElement('div');
      div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
      div.dataset.msgid = m.id;
      div.innerHTML = `
        <div class="chat-avatar" style="background:${m.avatar_color}">${m.display_name.slice(0,1).toUpperCase()}</div>
        <div class="chat-bubble">
          ${!isMine ? `<div class="chat-name">${escapeHtml(m.display_name)}</div>` : ''}
          <div class="chat-text">${escapeHtml(m.body)}</div>
          <div class="chat-time">${time}</div>
        </div>`;
      box.appendChild(div);
      lastMessageTime = m.created_at;
    });

    if (msgs.length || fullLoad) {
      box.scrollTop = box.scrollHeight;
    }
  } catch(e) { console.warn('Chat error:', e.message); }
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  input.disabled = true;
  try {
    await api(`/api/trips/${trip.id}/messages`, { method:'POST', body:{ body } });
    await loadMessages(false);
  } catch(e) { alert('Could not send message: ' + e.message); input.value = body; }
  finally { input.disabled = false; input.focus(); }
}

// ---------------- reservations ----------------
const RESY_CITY_CODES = {
  'new york': 'nyc', 'nyc': 'nyc', 'manhattan': 'nyc', 'brooklyn': 'nyc',
  'los angeles': 'la', 'la': 'la', 'hollywood': 'la', 'santa monica': 'la',
  'chicago': 'chi', 'san francisco': 'sf', 'miami': 'mia', 'miami beach': 'mia',
  'washington': 'dc', 'washington dc': 'dc', 'dc': 'dc',
  'boston': 'bos', 'las vegas': 'lv', 'seattle': 'sea', 'atlanta': 'atl',
  'houston': 'hou', 'dallas': 'dal', 'denver': 'den', 'portland': 'pdx',
  'nashville': 'nas', 'austin': 'aus', 'philadelphia': 'phl', 'phoenix': 'phx',
  'san diego': 'sd', 'minneapolis': 'msp', 'new orleans': 'nola',
  'london': 'lon', 'paris': 'par', 'toronto': 'tor', 'montreal': 'mtl',
  'amsterdam': 'ams', 'barcelona': 'bcn', 'rome': 'rom', 'tokyo': 'tok'
};

function resyCityCode(cityName) {
  if (!cityName) return 'nyc';
  const key = cityName.toLowerCase().split(',')[0].trim();
  return RESY_CITY_CODES[key] || key.replace(/\s+/g, '-');
}

function reservationDate() {
  // Use trip start date or today
  if (trip && trip.start_date) return trip.start_date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function partySize() {
  const el = document.getElementById('partySize');
  return el ? parseInt(el.value) || 2 : 2;
}

function openTableUrl(placeName, cityName) {
  const date = reservationDate();
  const term = encodeURIComponent(`${placeName}${cityName ? ', ' + cityName : ''}`);
  return `https://www.opentable.com/s/?term=${term}&covers=${partySize()}&dateTime=${date}T19%3A00`;
}

function resyUrl(placeName, cityName) {
  const date = reservationDate();
  const city = resyCityCode(cityName);
  const query = encodeURIComponent(placeName);
  return `https://resy.com/cities/${city}?query=${query}&date=${date}&seats=${partySize()}`;
}

function reservationBtnsHtml(placeName, cityName, category) {
  const cats = ['restaurant', 'bar', 'bar/nightlife', 'other'];
  if (!cats.includes((category || '').toLowerCase())) return '';
  return `
    <div class="reservation-btns">
      <a class="res-btn opentable-btn" href="${openTableUrl(placeName, cityName)}" target="_blank" rel="noopener">📅 OpenTable</a>
      <a class="res-btn resy-btn" href="${resyUrl(placeName, cityName)}" target="_blank" rel="noopener">📅 Resy</a>
    </div>`;
}

// ---------------- Chat send button
document.addEventListener('click', e => {
  if (e.target.id === 'chatSendBtn') sendMessage();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement.id === 'chatInput') sendMessage();
});

// ---------------- budget ----------------
document.getElementById('budgetCap').addEventListener('change', async (e) => {
  const cents = Math.round((parseFloat(e.target.value) || 0) * 100);
  await api(`/api/trips/${trip.id}`, { method:'PATCH', body:{ budget_cap_cents: cents } });
  trip.budget_cap_cents = cents;
  renderBudget();
});
function renderBudget() {
  const list = document.getElementById('budgetList');
  const total = (trip.places || []).reduce((s,p) => s + (p.estimated_cost_cents||0), 0);
  list.innerHTML = (trip.places || []).map(p => `<div class="budget-line"><span>${escapeHtml(p.name)}</span><span>${fmtMoney(p.estimated_cost_cents)}</span></div>`).join('') || '<div class="empty">No costs added yet.</div>';
  document.getElementById('budgetTotalRow').innerHTML = `<span>Total planned</span><span>${fmtMoney(total)}</span>`;
  const cap = trip.budget_cap_cents || 0;
  const pct = cap ? Math.min(100, (total/cap)*100) : 0;
  const fill = document.getElementById('budgetFill');
  fill.style.width = pct + '%';
  fill.classList.toggle('over', total > cap);
  document.getElementById('budgetHint').textContent = `${fmtMoney(total)} planned of ${fmtMoney(cap)}` + (total > cap ? ' — over budget' : '');
}

// ---------------- group / sharing ----------------
function renderMembers() {
  const members = trip.members || [];
  document.getElementById('memberList').innerHTML = members.map(m =>
    `<div class="member-chip"><span class="dot" style="background:${m.color||'#999'}"></span>${escapeHtml((m.users && m.users.display_name) || 'Traveler')}</div>`).join('') || '<div class="empty">Just you so far.</div>';
}

document.getElementById('shareBtn').addEventListener('click', async () => {
  const data = await api(`/api/trips/${trip.id}/share`, { method:'POST' });
  trip.share_code = data.shareCode;
  document.getElementById('shareCodeBox').innerHTML = `Share code: <b style="font-family:var(--mono);font-size:16px;letter-spacing:0.1em;">${data.shareCode}</b><br>Anyone who enters this code via "Join shared trip" sees this map and can add their own stops.`;
  document.querySelector('.tab[data-tab="group"]').click();
  alert('Share code generated: ' + data.shareCode + '\n\nGive this to your travel companions — they click "Join shared trip" and enter it.');
});

document.getElementById('joinBtn').addEventListener('click', async () => {
  const code = prompt('Enter the share code your travel companion gave you:');
  if (!code) return;
  try {
    const { trip: joined } = await api(`/api/share/${code.toUpperCase().trim()}/join`, { method:'POST' });
    await loadTrip(joined.id);
    await loadTripsList();
    alert('Joined trip: ' + joined.destination_city);
  } catch (e) { alert(e.message); }
});

document.getElementById('exportBtn').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="itinerary"]').click();
  window.print();
});

// ---------------- trip lifecycle ----------------
async function loadTripsList() {
  myTrips = await api('/api/trips');
  populateTripSwitcher();
}
function populateTripSwitcher() {
  const sw = document.getElementById('tripSwitcher');
  sw.innerHTML = myTrips.map(t => `<option value="${t.id}" ${trip && t.id===trip.id ? 'selected':''}>${escapeHtml(t.name)} — ${escapeHtml(t.destination_city)}</option>`).join('');
}
document.getElementById('tripSwitcher').addEventListener('change', (e) => loadTrip(e.target.value));

async function loadTrip(id) {
  trip = await api(`/api/trips/${id}`);
  hydrateUIFromTrip();
}

document.getElementById('newTripBtn').addEventListener('click', () => promptNewTrip());
async function promptNewTrip() {
  const name = prompt('Trip name:', 'My Trip');
  if (!name) return;
  const city = prompt('Destination city:', 'Amsterdam, Netherlands');
  if (!city) return;
  const created = await api('/api/trips', { method:'POST', body:{ name, destinationCity: city, pace:'moderate', transportMode:'driving', budgetCapCents: 80000 } });
  await loadTripsList();
  await loadTrip(created.id);
}

function hydrateUIFromTrip() {
  document.getElementById('tripNameInput').value = trip.name || '';
  document.getElementById('cityInput').value = trip.destination_city || '';
  document.getElementById('startDate').value = trip.start_date || '';
  document.getElementById('endDate').value = trip.end_date || '';
  document.getElementById('emergencyNum').value = trip.emergency_number || '';
  document.getElementById('embassyInfo').value = trip.embassy_info || '';
  document.getElementById('budgetCap').value = ((trip.budget_cap_cents||0)/100).toFixed(0);

  document.querySelectorAll('#pacePills .pill').forEach(p => p.classList.toggle('active', p.dataset.pace === trip.pace));
  document.querySelectorAll('#modePills .pill').forEach(p => p.classList.toggle('active', p.dataset.mode === trip.transport_mode));

  const base = primaryBase();
  if (hotelMarker) { map.removeLayer(hotelMarker); hotelMarker = null; }
  if (base) {
    document.getElementById('hotelInput').value = base.name;
    document.getElementById('hotelStatus').textContent = 'Located: ' + (base.address || '');
    hotelMarker = L.marker([base.lat, base.lng], { icon: hotelIcon() }).addTo(map).bindPopup('<b>🏨 Home base</b>');
  } else {
    document.getElementById('hotelInput').value = '';
    document.getElementById('hotelStatus').textContent = 'Not located yet — click "Locate on map".';
  }

  document.getElementById('shareCodeBox').innerHTML = trip.share_code
    ? `Share code: <b style="font-family:var(--mono);font-size:16px;">${trip.share_code}</b>`
    : 'Not shared yet. Click "Share trip" above to generate a code.';

  document.getElementById('itineraryOutput').innerHTML = '<div class="empty">Add your hotel and at least one place, then calculate.</div>';
  document.getElementById('mapStatDistance').textContent = '— total distance';
  document.getElementById('mapStatTime').textContent = '— travel time';

  renderPlaces(); redrawMarkers(); fitAll(); renderBudget(); renderMembers();
  // Load POIs for this trip's destination
  if (trip.destination_lat && trip.destination_lng) {
    loadCityPOIs(trip.destination_lat, trip.destination_lng, 3000);
  }
}

// ---------------- bootstrap ----------------
async function boot() {
  authMask.style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if (!map) initMap();
  // Capture current user ID for chat
  try {
    const stored = localStorage.getItem('waypoint_user');
    if (stored) { const u = JSON.parse(stored); currentUserId = u.id; }
  } catch(e) {}

  // City autocomplete — filter to cities/places
  setupAutocomplete('cityInput', 'cityAutocomplete', async (s) => {
    document.getElementById('cityInput').value = s.label;
    // Auto-save destination and load POIs
    if (trip) {
      try {
        const updated = await api(`/api/trips/${trip.id}`, {
          method: 'PATCH',
          body: { destination_city: s.label, destination_lat: s.lat, destination_lng: s.lng }
        });
        Object.assign(trip, updated);
        map.setView([s.lat, s.lng], 13);
        loadCityPOIs(s.lat, s.lng, 3000);
      } catch(e) { console.warn('Could not save destination:', e.message); }
    }
  }, 'city');

  // Hotel autocomplete — all place types
  setupAutocomplete('hotelInput', 'hotelAutocomplete', async (s) => {
    document.getElementById('hotelInput').value = s.label;
    // Auto-trigger hotel locate with the selected address
    const statusEl = document.getElementById('hotelStatus');
    statusEl.textContent = 'Locating…';
    try {
      const base = await api(`/api/trips/${trip.id}/base`, {
        method: 'POST',
        body: { name: s.name || s.label, address: s.label, checkIn: document.getElementById('startDate').value || null, checkOut: document.getElementById('endDate').value || null }
      });
      trip.bases = [base, ...(trip.bases || []).filter(b => !b.is_primary)];
      if (hotelMarker) map.removeLayer(hotelMarker);
      hotelMarker = L.marker([base.lat, base.lng], { icon: hotelIcon() }).addTo(map)
        .bindPopup('<b>🏨 ' + (s.name || s.label) + '</b><br>Home base');
      map.setView([base.lat, base.lng], 15);
      statusEl.textContent = 'Located: ' + base.address;
    } catch(e) { statusEl.textContent = e.message; }
  }, 'all');

  loadCelebrityPicks();
  try {
    await loadTripsList();
    if (!myTrips.length) { await promptNewTrip(); }
    else { await loadTrip(myTrips[0].id); }
  } catch (e) {
    const msg = e.message.includes('Failed to fetch')
      ? 'Cannot reach the server — it may be waking up (free tier cold start takes ~60s). Refresh and try again.'
      : 'Could not load your trips: ' + e.message;
    alert(msg);
  }
}

// Catch any unhandled promise rejections so the app doesn't silently die
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason);
});

(function start() {
  if (token) { boot(); }
  else { authMask.style.display = 'flex'; }
})();
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('waypoint_token'); localStorage.removeItem('waypoint_user');
  token = null; currentUser = null; trip = null;
  document.getElementById('app').style.display = 'none';
  authMask.style.display = 'flex';
});

// ---------------- Map ----------------
function initMap() {
  map = L.map('map', { zoomControl: false }).setView([52.3676, 4.9041], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}
function numIcon(n) { return L.divIcon({ className:'', html:`<div class="num-pin"><span>${n}</span></div>`, iconSize:[26,26], iconAnchor:[13,26] }); }
function hotelIcon() { return L.divIcon({ className:'', html:`<div class="hotel-pin">🏨</div>`, iconSize:[30,30], iconAnchor:[15,15] }); }

// ---------------- auto-populate POIs from Overpass ----------------
let poiMarkers = [];
let poiLayer = null;
let poiCategoryFilters = { restaurant: true, bar: true, museum: true, landmark: true, shopping: true };

const POI_CATEGORIES = {
  restaurant: { tags: [['amenity','restaurant'],['amenity','cafe'],['amenity','fast_food']], color:'#FF6B35', emoji:'🍽️' },
  bar: { tags: [['amenity','bar'],['amenity','pub'],['amenity','nightclub']], color:'#7C3AED', emoji:'🍸' },
  museum: { tags: [['tourism','museum'],['tourism','gallery'],['tourism','artwork']], color:'#2563EB', emoji:'🏛️' },
  landmark: { tags: [['tourism','attraction'],['historic','monument'],['historic','memorial'],['tourism','viewpoint']], color:'#DC2626', emoji:'📍' },
  shopping: { tags: [['shop','mall'],['shop','department_store'],['shop','boutique'],['amenity','marketplace']], color:'#DB2777', emoji:'🛍️' },
};

async function loadCityPOIs(lat, lng, radiusM = 3000) {
  clearPOIMarkers();
  const queries = Object.entries(POI_CATEGORIES).map(([cat, cfg]) => {
    return cfg.tags.map(([k,v]) => `node["${k}"="${v}"](around:${radiusM},${lat},${lng});`).join('');
  }).join('');

  const overpassQuery = `[out:json][timeout:20];(${queries});out body;`;
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: 'data=' + encodeURIComponent(overpassQuery)
    });
    const data = await res.json();
    renderPOIMarkers(data.elements || []);
  } catch(e) { console.warn('POI load failed:', e.message); }
}

function getPOICategory(el) {
  const tags = el.tags || {};
  if (tags.amenity === 'restaurant' || tags.amenity === 'cafe' || tags.amenity === 'fast_food') return 'restaurant';
  if (tags.amenity === 'bar' || tags.amenity === 'pub' || tags.amenity === 'nightclub') return 'bar';
  if (tags.tourism === 'museum' || tags.tourism === 'gallery') return 'museum';
  if (tags.tourism === 'attraction' || tags.historic) return 'landmark';
  if (tags.shop) return 'shopping';
  return 'landmark';
}

function renderPOIMarkers(elements) {
  clearPOIMarkers();
  const seen = new Set();
  elements.forEach(el => {
    if (!el.lat || !el.lon) return;
    const name = el.tags?.name;
    if (!name) return; // skip unnamed places
    const key = `${name}|${Math.round(el.lat*100)}|${Math.round(el.lon*100)}`;
    if (seen.has(key)) return;
    seen.add(key);

    const cat = getPOICategory(el);
    const cfg = POI_CATEGORIES[cat];
    const icon = L.divIcon({
      className: 'poi-icon',
      html: `<div class="poi-pin" style="background:${cfg.color}" title="${name}">${cfg.emoji}</div>`,
      iconSize: [30,30], iconAnchor: [15,15]
    });

    const marker = L.marker([el.lat, el.lon], { icon, opacity: 0.85 })
      .bindPopup(`
        <div style="min-width:180px;">
          <strong>${name}</strong><br>
          <span style="font-size:11px;color:#666;">${cat}</span><br>
          <button onclick="addPOIToTrip('${name.replace(/'/g,"\'")}','${cat}',${el.lat},${el.lon})"
            style="margin-top:6px;padding:4px 10px;background:#6366F1;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;width:100%;">
            + Add to my trip
          </button>
        </div>
      `);
    marker._poiCat = cat;
    if (poiCategoryFilters[cat]) marker.addTo(map);
    poiMarkers.push(marker);
  });
  if (poiMarkers.length > 0) {
    document.getElementById('poiToggleBtn') && (document.getElementById('poiToggleBtn').textContent = `📍 ${poiMarkers.length} nearby places`);
  }
}

function clearPOIMarkers() {
  poiMarkers.forEach(m => map.removeLayer(m));
  poiMarkers = [];
}

function togglePOICategory(cat) {
  poiCategoryFilters[cat] = !poiCategoryFilters[cat];
  poiMarkers.forEach(m => {
    if (m._poiCat === cat) {
      if (poiCategoryFilters[cat]) { m.addTo(map); }
      else { map.removeLayer(m); }
    }
  });
  // Update toggle button appearance
  const btn = document.querySelector(`.poi-cat-btn[data-cat="${cat}"]`);
  if (btn) btn.classList.toggle('active', poiCategoryFilters[cat]);
  // Update count
  const visible = poiMarkers.filter(m => poiCategoryFilters[m._poiCat]).length;
  const toggleBtn = document.getElementById('poiToggleBtn');
  if (toggleBtn) toggleBtn.textContent = `📍 ${visible} nearby`;
}
window.togglePOICategory = togglePOICategory;

async function addPOIToTrip(name, category, lat, lng) {
  try {
    const place = await api(`/api/trips/${trip.id}/places`, {
      method: 'POST',
      body: { query: `${name}, ${trip.destination_city || ''}`, name, category, visitDurationMin: 60, estimatedCostCents: 0 }
    });
    trip.places = [...(trip.places || []), place];
    renderPlaces(); redrawMarkers(); renderBudget();
    map.closePopup();
    document.querySelector('.tab[data-tab="places"]').click();
  } catch(e) { alert('Could not add place: ' + e.message); }
}
window.addPOIToTrip = addPOIToTrip; // expose for popup onclick

function redrawMarkersInOrder() {
  // Redraw markers using current trip.places order (for manual mode)
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  (trip.places || []).forEach((p, i) => {
    if (!p.lat || !p.lng) return;
    const icon = L.divIcon({ className:'place-icon', html:`<div class="pin-num">${i+1}</div>`, iconSize:[28,28], iconAnchor:[14,14] });
    const m = L.marker([p.lat, p.lng], { icon }).addTo(map).bindPopup(`<b>${p.name}</b><br>${p.category||''}`);
    placeMarkers.push(m);
  });
}

function redrawMarkers() {
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  (trip.places || []).forEach((p, i) => {
    // In manual order mode, use array index; otherwise use route_position from DB
    const order = manualOrder ? (i + 1) : ((p.route_position) ? p.route_position : i + 1);
    const m = L.marker([p.lat, p.lng], { icon: numIcon(order) }).addTo(map);
    m.bindPopup(`<b>${escapeHtml(p.name)}</b><br>${p.category}<br>${escapeHtml(p.address || '')}`);
    placeMarkers.push(m);
  });
  document.getElementById('mapStatPlaces').textContent = (trip.places || []).length + ((trip.places || []).length === 1 ? ' place' : ' places');
}
function drawRouteLine(coordsLatLng) {
  if (routeLine) map.removeLayer(routeLine);
  if (!coordsLatLng || coordsLatLng.length < 2) return;
  routeLine = L.polyline(coordsLatLng, { color:'#E2654A', weight:3, dashArray:'1,8', lineCap:'round' }).addTo(map);
}
function fitAll() {
  const pts = [];
  const base = primaryBase();
  if (base) pts.push([base.lat, base.lng]);
  (trip.places || []).forEach(p => pts.push([p.lat, p.lng]));
  if (pts.length) map.fitBounds(pts, { padding:[60,60] });
}
function primaryBase() { return (trip.bases || []).find(b => b.is_primary) || (trip.bases || [])[0] || null; }

async function ensureBases() {
  const fresh = await api(`/api/trips/${trip.id}`);
  trip.bases = fresh.bases || [];
}

// ---------------- client-side geocoding / OSRM geometry (for the visual route line only) ----------------
async function osrmRouteGeometry(points, profile) {
  try {
    const coordStr = points.map(p => `${p.lng},${p.lat}`).join(';');
    const url = `https://router.project-osrm.org/route/v1/${profile}/${coordStr}?overview=full&geometries=geojson`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok') return data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
  } catch (e) { /* fall through */ }
  return points.map(p => [p.lat, p.lng]);
}

// ---------------- helpers ----------------
function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function catTagHtml(cat){ return `<span class="tag ${cat||'other'}">${cat||'other'}</span>`; }
function fmtMoney(cents){ return '$' + ((cents||0)/100).toFixed(0); }

// ---------------- tabs ----------------
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tabcontent').forEach(c => c.hidden = true);
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).hidden = false;
    if (btn.dataset.tab === 'group') { startChat(); }
    else { stopChat(); }
  });
});

// ---------------- autocomplete ----------------
let acDebounceTimer = null;

async function fetchSuggestions(query, type = 'all') {
  if (!query || query.length < 2) return [];
  try {
    // For cities only, filter by type
    const typeParam = type === 'city' ? '&layer=city&layer=district&layer=county' : '';
    const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6${typeParam}`);
    const data = await res.json();
    return (data.features || []).map(f => {
      const p = f.properties;
      const parts = [p.name, p.city || p.district, p.state, p.country].filter(Boolean);
      const label = [...new Set(parts)].join(', ');
      return { label, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], name: p.name };
    }).filter((s, i, arr) => arr.findIndex(x => x.label === s.label) === i); // dedupe
  } catch(e) { return []; }
}

function setupAutocomplete(inputId, listId, onSelect, type = 'all') {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  input.addEventListener('input', () => {
    clearTimeout(acDebounceTimer);
    const q = input.value.trim();
    if (!q || q.length < 2) { list.innerHTML = ''; list.hidden = true; return; }
    acDebounceTimer = setTimeout(async () => {
      const suggestions = await fetchSuggestions(q, type);
      if (!suggestions.length) { list.innerHTML = ''; list.hidden = true; return; }
      list.innerHTML = suggestions.map((s, i) =>
        `<div class="ac-item" data-idx="${i}">${s.label}</div>`
      ).join('');
      list.hidden = false;
      list._suggestions = suggestions;
      list.querySelectorAll('.ac-item').forEach(item => {
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          const s = list._suggestions[parseInt(item.dataset.idx)];
          input.value = s.label;
          list.innerHTML = ''; list.hidden = true;
          onSelect(s);
        });
      });
    }, 250);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => { list.innerHTML = ''; list.hidden = true; }, 200);
  });

  input.addEventListener('keydown', e => {
    const items = list.querySelectorAll('.ac-item');
    const active = list.querySelector('.ac-item.focused');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = active ? active.nextElementSibling : items[0];
      if (next) { active && active.classList.remove('focused'); next.classList.add('focused'); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = active ? active.previousElementSibling : items[items.length - 1];
      if (prev) { active && active.classList.remove('focused'); prev.classList.add('focused'); }
    } else if (e.key === 'Enter' && active) {
      e.preventDefault();
      active.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      list.innerHTML = ''; list.hidden = true;
    }
  });
}

// ---------------- setup tab ----------------
document.querySelectorAll('#pacePills .pill').forEach(p => {
  p.addEventListener('click', async () => {
    document.querySelectorAll('#pacePills .pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    if (!trip) return;
    await api(`/api/trips/${trip.id}`, { method:'PATCH', body:{ pace: p.dataset.pace } });
    trip.pace = p.dataset.pace;
  });
});
document.querySelectorAll('#modePills .pill').forEach(p => {
  p.addEventListener('click', async () => {
    document.querySelectorAll('#modePills .pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active');
    if (!trip) return;
    await api(`/api/trips/${trip.id}`, { method:'PATCH', body:{ transport_mode: p.dataset.mode } });
    trip.transport_mode = p.dataset.mode;
  });
});

document.getElementById('saveSetupBtn').addEventListener('click', async () => {
  const body = {
    name: document.getElementById('tripNameInput').value,
    destination_city: document.getElementById('cityInput').value,
    start_date: document.getElementById('startDate').value || null,
    end_date: document.getElementById('endDate').value || null,
    emergency_number: document.getElementById('emergencyNum').value,
    embassy_info: document.getElementById('embassyInfo').value,
  };
  const updated = await api(`/api/trips/${trip.id}`, { method:'PATCH', body });
  Object.assign(trip, updated);
  populateTripSwitcher();
  // Auto-load nearby POIs when destination is set
  if (updated.destination_lat && updated.destination_lng) {
    loadCityPOIs(updated.destination_lat, updated.destination_lng, 3000);
    map.setView([updated.destination_lat, updated.destination_lng], 14);
  }
});

document.getElementById('deleteTripBtn').addEventListener('click', async () => {
  if (!confirm(`Delete "${trip.name}"? This cannot be undone.`)) return;
  try {
    await api(`/api/trips/${trip.id}`, { method: 'DELETE' });
    // Remove from local list and reload
    myTrips = myTrips.filter(t => t.id !== trip.id);
    if (myTrips.length) {
      await loadTrip(myTrips[0].id);
    } else {
      await promptNewTrip();
    }
  } catch(e) { alert('Could not delete trip: ' + e.message); }
});

document.getElementById('hotelSearchBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('hotelStatus');
  const name = document.getElementById('hotelInput').value.trim();
  if (!name) return;
  statusEl.textContent = 'Locating…';
  try {
    const base = await api(`/api/trips/${trip.id}/base`, { method:'POST', body:{ name, address: name + ', ' + document.getElementById('cityInput').value, checkIn: document.getElementById('startDate').value || null, checkOut: document.getElementById('endDate').value || null } });
    trip.bases = [base, ...(trip.bases || []).filter(b => !b.is_primary)];
    if (hotelMarker) map.removeLayer(hotelMarker);
    hotelMarker = L.marker([base.lat, base.lng], { icon: hotelIcon() }).addTo(map).bindPopup('<b>🏨 ' + escapeHtml(name) + '</b><br>Home base');
    map.setView([base.lat, base.lng], 14);
    statusEl.textContent = 'Located: ' + base.address;
  } catch (e) { statusEl.textContent = e.message; }
});

// ---------------- places tab ----------------
let activeCategory = 'landmark';
document.querySelectorAll('#categoryPills .pill').forEach(p => {
  p.addEventListener('click', () => {
    // Toggle this pill on/off (multi-select for POI filter)
    const cat = p.dataset.cat;
    const isActive = p.classList.contains('active');

    if (isActive) {
      // Only deactivate if at least one other pill stays active
      const activePills = document.querySelectorAll('#categoryPills .pill.active');
      if (activePills.length <= 1) return; // keep at least one
      p.classList.remove('active');
      poiCategoryFilters[cat] = false;
    } else {
      p.classList.add('active');
      poiCategoryFilters[cat] = true;
    }

    // Update POI markers on map
    poiMarkers.forEach(m => {
      if (m._poiCat === cat) {
        if (poiCategoryFilters[cat]) { m.addTo(map); }
        else { map.removeLayer(m); }
      }
    });

    // Set activeCategory to the last activated pill
    activeCategory = cat;
  });
});

document.getElementById('addPlaceBtn').addEventListener('click', async () => {
  const q = document.getElementById('placeSearch').value.trim();
  const statusEl = document.getElementById('placeSearchStatus');
  if (!q) { statusEl.textContent = 'Enter a place name first.'; return; }
  statusEl.textContent = 'Searching…';
  try {
    const cityCtx = document.getElementById('cityInput').value || trip.destination_city || '';
    const place = await api(`/api/trips/${trip.id}/places`, {
      method:'POST',
      body: {
        query: q + ', ' + cityCtx,
        name: q,
        category: activeCategory,
        visitDurationMin: parseInt(document.getElementById('placeDuration').value) || 60,
        estimatedCostCents: Math.round((parseFloat(document.getElementById('placeCost').value) || 0) * 100),
        notes: document.getElementById('placeNotes').value,
      }
    });
    trip.places = [...(trip.places || []), place];
    document.getElementById('placeSearch').value = ''; document.getElementById('placeNotes').value = '';
    statusEl.textContent = 'Added: ' + place.address;
    renderPlaces(); redrawMarkers(); fitAll(); renderBudget();
  } catch (e) { statusEl.textContent = e.message; }
});

let manualOrder = false;
let dragSrcIdx = null;

function renderPlaces() {
  const list = document.getElementById('placeList');
  document.getElementById('placeCount').textContent = (trip.places || []).length;
  if (!trip.places || !trip.places.length) { list.innerHTML = '<div class="empty">No places yet. Search above, or add a Celebrity Pick.</div>'; return; }

  // Order toggle UI
  const toggleHtml = `
    <div class="order-toggle">
      <span>Route order:</span>
      <button class="toggle-btn ${!manualOrder ? 'active' : ''}" id="useOptimized">⚡ Optimized</button>
      <button class="toggle-btn ${manualOrder ? 'active' : ''}" id="useManual">✋ My Order</button>
    </div>`;

  list.innerHTML = toggleHtml + trip.places.map((p, i) => `
    <div class="placecard ${manualOrder ? 'draggable' : ''}" draggable="${manualOrder}" data-idx="${i}" data-id="${p.id}">
      <div class="drag-handle ${manualOrder ? '' : 'hidden'}">⠿</div>
      <div class="num">${i+1}</div>
      <h4>${escapeHtml(p.name)}</h4>
      <div class="meta">${catTagHtml(p.category)} <span>${fmtMoney(p.estimated_cost_cents)} · ${p.visit_duration_min||60}min</span></div>
      ${p.notes ? `<div class="hint">${escapeHtml(p.notes)}</div>` : ''}
      ${reservationBtnsHtml(p.name, trip.destination_city, p.category)}
      <div class="time-row">
        <label class="time-label">Day</label>
        <input class="time-day-input" type="number" min="1" max="30" value="${p.scheduled_day || 1}" data-placeid="${p.id}" data-field="day">
        <label class="time-label">Time</label>
        <input class="time-input" type="time" value="${p.scheduled_time ? p.scheduled_time.slice(0,5) : ''}" data-placeid="${p.id}" data-field="time" placeholder="--:--">
      </div>
      <div class="actions"><button class="iconbtn" data-remove="${p.id}">Remove</button></div>
    </div>`).join('');

  // Toggle handlers
  document.getElementById('useOptimized').addEventListener('click', async () => {
    manualOrder = false;
    // Re-fetch places in DB order (route_position from last optimization)
    try { trip.places = await api(`/api/trips/${trip.id}/places`); } catch(e) {}
    renderPlaces(); redrawMarkers();
  });
  document.getElementById('useManual').addEventListener('click', () => { manualOrder = true; renderPlaces(); });

  // Remove handlers
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/trips/${trip.id}/places/${btn.dataset.remove}`, { method:'DELETE' });
      trip.places = trip.places.filter(p => p.id !== btn.dataset.remove);
      renderPlaces(); redrawMarkers(); renderBudget();
    });
  });

  // Time/day pickers — save on change
  list.querySelectorAll('.time-input, .time-day-input').forEach(input => {
    input.addEventListener('change', async () => {
      const placeId = input.dataset.placeid;
      const field = input.dataset.field;
      const place = trip.places.find(p => p.id === placeId);
      if (!place) return;
      if (field === 'time') {
        place.scheduled_time = input.value || null;
        await api(`/api/trips/${trip.id}/places/${placeId}`, { method:'PATCH', body:{ scheduled_time: input.value || null } });
      } else if (field === 'day') {
        place.scheduled_day = parseInt(input.value) || 1;
        await api(`/api/trips/${trip.id}/places/${placeId}`, { method:'PATCH', body:{ scheduled_day: parseInt(input.value) || 1 } });
      }
    });
  });

  // Drag-and-drop handlers
  if (manualOrder) {
    list.querySelectorAll('.placecard[draggable="true"]').forEach(card => {
      card.addEventListener('dragstart', e => {
        dragSrcIdx = parseInt(card.dataset.idx);
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', async e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        const destIdx = parseInt(card.dataset.idx);
        if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
        // Reorder trip.places array
        const moved = trip.places.splice(dragSrcIdx, 1)[0];
        trip.places.splice(destIdx, 0, moved);
        dragSrcIdx = null;
        // Save new order to backend
        try {
          await api(`/api/trips/${trip.id}/places/reorder`, {
            method: 'POST',
            body: { order: trip.places.map((p, i) => ({ id: p.id, position: i + 1 })) }
          });
        } catch (e) { console.warn('Could not save order:', e.message); }
        renderPlaces(); redrawMarkers();
      });
    });
  }
}

// ---------------- influencer / celebrity guides tab ----------------
let allGuides = [];
let guideFilter = { person: '', city: '', category: '' };

async function loadCelebrityPicks() {
  const list = document.getElementById('celebList');
  try {
    allGuides = await api('/api/celebrity-picks');

    // Auto-filter by destination city if trip has one
    if (trip && trip.destination_city && !guideFilter.city) {
      const cityName = trip.destination_city.split(',')[0].trim();
      guideFilter.city = cityName;
    }

    renderGuideFilters();
    renderGuides();
  } catch (e) {
    list.innerHTML = `<div class="empty">${e.message}</div>`;
  }
}

function renderGuideFilters() {
  const list = document.getElementById('celebList');

  // Build unique person and category lists
  const people = [...new Set(allGuides.map(g => g.celebrity_name))].sort();
  const categories = [...new Set(allGuides.map(g => g.category).filter(Boolean))].sort();

  const filterHtml = `
    <div class="guide-filters">
      <input class="guide-search" id="guideCityFilter" type="text" placeholder="🌍 Filter by city..." value="${escapeHtml(guideFilter.city)}">
      <select id="guidePersonFilter" class="guide-select">
        <option value="">All guides</option>
        ${people.map(p => `<option value="${escapeHtml(p)}" ${guideFilter.person === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      <select id="guideCatFilter" class="guide-select">
        <option value="">All types</option>
        ${categories.map(c => `<option value="${escapeHtml(c)}" ${guideFilter.category === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
      </select>
      <button class="iconbtn" id="guideClearBtn">Clear</button>
    </div>
    <div id="guideCards"></div>`;

  list.innerHTML = filterHtml;

  document.getElementById('guideCityFilter').addEventListener('input', e => { guideFilter.city = e.target.value; renderGuides(); });
  document.getElementById('guidePersonFilter').addEventListener('change', e => { guideFilter.person = e.target.value; renderGuides(); });
  document.getElementById('guideCatFilter').addEventListener('change', e => { guideFilter.category = e.target.value; renderGuides(); });
  document.getElementById('guideClearBtn').addEventListener('click', () => {
    guideFilter = { person: '', city: '', category: '' };
    document.getElementById('guideCityFilter').value = '';
    document.getElementById('guidePersonFilter').value = '';
    document.getElementById('guideCatFilter').value = '';
    renderGuides();
  });
}

function renderGuides() {
  const cards = document.getElementById('guideCards');
  if (!cards) return;

  let filtered = allGuides.filter(g => {
    const cityMatch = !guideFilter.city || g.city.toLowerCase().includes(guideFilter.city.toLowerCase()) || (g.country && g.country.toLowerCase().includes(guideFilter.city.toLowerCase()));
    const personMatch = !guideFilter.person || g.celebrity_name === guideFilter.person;
    const catMatch = !guideFilter.category || g.category === guideFilter.category;
    return cityMatch && personMatch && catMatch;
  });

  // Group by celebrity
  const grouped = {};
  filtered.forEach(g => {
    if (!grouped[g.celebrity_name]) grouped[g.celebrity_name] = [];
    grouped[g.celebrity_name].push(g);
  });

  if (!filtered.length) {
    cards.innerHTML = '<div class="empty">No guides match your filters. Try a different city or clear filters.</div>';
    return;
  }

  cards.innerHTML = Object.entries(grouped).map(([name, picks]) => `
    <div class="influencer-section">
      <div class="influencer-header">
        <div class="influencer-avatar">${name.split(' ').map(w=>w[0]).join('').slice(0,2)}</div>
        <div>
          <div class="influencer-name">${escapeHtml(name)}</div>
          <div class="influencer-count">${picks.length} pick${picks.length>1?'s':''}</div>
        </div>
      </div>
      <div class="guide-pick-list">
        ${picks.map((g, i) => `
          <div class="guide-pick-card" data-gidx="${allGuides.indexOf(g)}">
            <div class="guide-pick-top">
              <div>
                <div class="guide-pick-name">${escapeHtml(g.place_name)}</div>
                <div class="guide-pick-meta">${escapeHtml(g.city)}, ${escapeHtml(g.country||'')} ${catTagHtml(g.category)}</div>
              </div>
              <button class="btn btn-gold btn-small add-guide-btn" data-gidx="${allGuides.indexOf(g)}">+ Add</button>
            </div>
            ${g.note ? `<p class="guide-pick-note">${escapeHtml(g.note)}</p>` : ''}
          </div>`).join('')}
      </div>
    </div>`).join('');

  cards.querySelectorAll('.add-guide-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const g = allGuides[parseInt(btn.dataset.gidx)];
      btn.textContent = '…';
      btn.disabled = true;
      try {
        const place = await api(`/api/trips/${trip.id}/places`, {
          method:'POST',
          body: { query: `${g.place_name}, ${g.city}, ${g.country||''}`, name: g.place_name, category: g.category || 'restaurant', notes: g.note, visitDurationMin: 75, estimatedCostCents: 0, celebrityPickId: g.id }
        });
        trip.places = [...(trip.places || []), place];
        renderPlaces(); redrawMarkers(); fitAll(); renderBudget();
        btn.textContent = '✅ Added';
        btn.style.background = 'var(--forest)';
      } catch(e) {
        btn.textContent = '+ Add';
        btn.disabled = false;
        alert('Could not add place: ' + e.message);
      }
    });
  });
}

// ---------------- itinerary / routing ----------------
document.getElementById('optimizeBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('optimizeStatus');
  await ensureBases();
  const base = primaryBase();
  if (!base) { statusEl.textContent = 'Set your hotel location in Setup first.'; return; }
  if (!trip.places || !trip.places.length) { statusEl.textContent = 'Add at least one place first.'; return; }

  if (manualOrder) {
    // Use the user's manual drag-and-drop order — no backend calculation
    statusEl.textContent = 'Building itinerary in your order…';
    try {
      const pace = trip.pace || 5;
      const days = [];
      let dayNum = 1, stops = [];
      trip.places.forEach((p, i) => {
        stops.push({ ...p, legDistanceM: null, legDurationS: null });
        if (stops.length >= pace || i === trip.places.length - 1) {
          days.push({ day: dayNum++, stops });
          stops = [];
        }
      });
      const totalStops = trip.places.length;
      const result = { days, totalDistanceM: 0, totalDurationS: 0, routeSource: 'manual' };
      lastItinerary = result;
      document.getElementById('mapStatDistance').textContent = `${totalStops} stops`;
      document.getElementById('mapStatTime').textContent = 'Custom order';
      redrawMarkers(); // uses manualOrder flag to number pins correctly
      const profile = trip.transport_mode === 'walking' ? 'foot' : 'driving';
      const geomPoints = [{ lat: base.lat, lng: base.lng }, ...trip.places.map(p => ({ lat: p.lat, lng: p.lng }))];
      const geom = await osrmRouteGeometry(geomPoints, profile);
      drawRouteLine(geom);
      renderItinerary(result, base);
      statusEl.textContent = `Custom order applied — ${totalStops} stops in your sequence.`;
    } catch (e) { statusEl.textContent = e.message; }
    return;
  }

  // ⏰ TIME-BASED SCHEDULING (default when not in manual order)
  statusEl.textContent = 'Building your day schedule…';
  try {
    const hasTimedPlaces = trip.places.some(p => p.scheduled_time);
    const profile = trip.transport_mode === 'walking' ? 'foot' : 'driving';

    if (hasTimedPlaces) {
      // Sort by day then scheduled_time
      const sorted = [...trip.places].sort((a, b) => {
        const dayA = a.scheduled_day || 1, dayB = b.scheduled_day || 1;
        if (dayA !== dayB) return dayA - dayB;
        const tA = a.scheduled_time || '23:59', tB = b.scheduled_time || '23:59';
        return tA.localeCompare(tB);
      });

      // Group by day
      const dayMap = {};
      sorted.forEach(p => {
        const d = p.scheduled_day || 1;
        if (!dayMap[d]) dayMap[d] = [];
        dayMap[d].push(p);
      });

      const days = [];
      let totalDurationS = 0;
      const conflicts = [];
      const allSorted = [];

      for (const [dayNum, places] of Object.entries(dayMap)) {
        const stops = [];
        let prevLat = base.lat, prevLng = base.lng;
        let prevEndTime = null;

        for (const p of places) {
          let legDurationS = null;
          try {
            const r = await fetch(`https://router.project-osrm.org/route/v1/${profile}/${prevLng},${prevLat};${p.lng},${p.lat}?overview=false`);
            const d = await r.json();
            if (d.code === 'Ok') legDurationS = d.routes[0].duration;
          } catch(e) {}

          // Check for timing conflicts
          if (prevEndTime && p.scheduled_time && legDurationS) {
            const gap = timeToMins(p.scheduled_time) - timeToMins(prevEndTime);
            const travelMins = Math.ceil(legDurationS / 60);
            if (travelMins > gap) conflicts.push({ name: p.name, shortfall: travelMins - gap });
          }

          const visitMins = p.visit_duration_min || 60;
          prevEndTime = p.scheduled_time ? addMins(p.scheduled_time, visitMins) : null;
          prevLat = p.lat; prevLng = p.lng;
          if (legDurationS) totalDurationS += legDurationS;

          const stop = { ...p, legDurationS, legDistanceM: null, scheduledTimeDisplay: p.scheduled_time ? formatTime12(p.scheduled_time) : null, hasConflict: conflicts.some(c => c.name === p.name) };
          stops.push(stop);
          allSorted.push(stop);
        }
        days.push({ day: parseInt(dayNum), stops });
      }

      const result = { days, totalDistanceM: 0, totalDurationS, routeSource: 'timed', conflicts };
      lastItinerary = result;
      const numDays = Object.keys(dayMap).length;
      document.getElementById('mapStatDistance').textContent = `${trip.places.length} stops · ${numDays} day${numDays > 1 ? 's' : ''}`;
      document.getElementById('mapStatTime').textContent = Math.round(totalDurationS/60) + ' min travel';
      redrawMarkers();
      const geom = await osrmRouteGeometry([{ lat: base.lat, lng: base.lng }, ...allSorted.map(p => ({ lat: p.lat, lng: p.lng }))], profile);
      drawRouteLine(geom);
      renderItinerary(result, base);

      if (conflicts.length) {
        statusEl.innerHTML = `⚠️ Schedule built — <span style="color:#DC2626;font-weight:700;">${conflicts.length} timing conflict${conflicts.length > 1 ? 's' : ''} detected</span>. Check highlighted stops.`;
      } else {
        statusEl.textContent = `✅ Schedule built — ${trip.places.length} stops across ${numDays} day${numDays > 1 ? 's' : ''}.`;
      }

    } else {
      // No times set — prompt user to add times
      statusEl.innerHTML = `💡 Add times to your places in <b>My Places</b> for a day schedule, or switch to <b>My Order</b> to set a custom sequence.`;
    }
  } catch(e) { statusEl.textContent = e.message; }
});

// ---- Time helpers ----
function timeToMins(t) { if (!t) return 0; const [h,m] = t.split(':').map(Number); return h*60+m; }
function addMins(t, mins) { let total = timeToMins(t) + mins; total = total % (24*60); return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`; }
function formatTime12(t) { if (!t) return ''; const [h,m] = t.split(':').map(Number); const ampm = h>=12?'PM':'AM'; return `${h%12||12}:${String(m).padStart(2,'0')} ${ampm}`; }

const visitedStops = new Set();

function renderItinerary(result, base) {
  let html = '';
  let prevId = 'base';
  let lastStopId = 'base';
  result.days.forEach(day => {
    html += `<div class="daygroup"><div class="dayhead">Day ${day.day} <span class="badge">${day.stops.length} stop${day.stops.length>1?'s':''}</span></div>`;
    day.stops.forEach((stop, si) => {
      const distKm = stop.legDistanceM ? (stop.legDistanceM/1000).toFixed(1) : '—';
      const minutes = stop.legDurationS ? Math.round(stop.legDurationS/60) : '—';
      const visited = visitedStops.has(stop.id);
      const timeDisplay = stop.scheduledTimeDisplay ? `<span class="stop-time">${stop.scheduledTimeDisplay}</span>` : '';
      const conflictClass = stop.hasConflict ? 'conflict' : '';
      html += `<div class="legrow"><span>↳ ${distKm} km</span><span class="dots"></span><span>${minutes} min</span></div>`;
      html += `<div class="stopcard ${visited ? 'visited' : ''} ${conflictClass}" style="margin-bottom:10px;" data-stopid="${stop.id}">
        <div class="stop-header">
          <div class="meta">${catTagHtml(stop.category)} <span>${stop.visit_duration_min||stop.visitDurationMin||60} min visit</span>${timeDisplay}</div>
          <button class="visit-btn ${visited ? 'done' : ''}" data-visit="${stop.id}" title="${visited ? 'Mark unvisited' : 'Mark as visited'}">${visited ? '✅ Visited' : '○ Mark visited'}</button>
        </div>
        ${stop.hasConflict ? `<div class="conflict-warning">⚠️ Not enough travel time — adjust your schedule</div>` : ''}
        <h4>${escapeHtml(stop.name)}</h4>
        <div class="hint">${escapeHtml(stop.address||'')}</div>
        ${reservationBtnsHtml(stop.name, trip.destination_city, stop.category)}
        <button class="uberbtn" data-from="${prevId}" data-to="${stop.id}">🚗 Request Uber here</button>
      </div>`;
      prevId = stop.id;
      lastStopId = stop.id;
    });
    html += `</div>`;
  });

  // Back to hotel button at the bottom
  html += `<div class="back-to-hotel">
    <div class="legrow"><span>↳ Return journey</span><span class="dots"></span><span>Home base</span></div>
    <div class="stopcard" style="margin-bottom:10px;background:var(--parchment);">
      <div class="meta"><span class="tag tag-land">🏨 Hotel</span></div>
      <h4>${escapeHtml(base.name || 'Home Base')}</h4>
      <div class="hint">${escapeHtml(base.address||'')}</div>
      <button class="uberbtn" data-from="${lastStopId}" data-to="base">🚗 Ride back to hotel</button>
    </div>
  </div>`;

  document.getElementById('itineraryOutput').innerHTML = html || '<div class="empty">Nothing to show yet.</div>';

  // Visit toggle handlers
  document.querySelectorAll('.visit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sid = btn.dataset.visit;
      if (visitedStops.has(sid)) { visitedStops.delete(sid); } else { visitedStops.add(sid); }
      renderItinerary(lastItinerary, base);
    });
  });

  // Uber button handlers
  document.querySelectorAll('.uberbtn[data-from]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const win = window.open('', '_blank');
        const ride = await api(`/api/trips/${trip.id}/rides`, { method:'POST', body:{ fromPlaceId: btn.dataset.from, toPlaceId: btn.dataset.to, provider:'uber' } });
        win.location.href = ride.deep_link;
      } catch (e) { alert('Could not start the ride request: ' + e.message); }
    });
  });
}

// ---------------- group chat ----------------
let chatPollInterval = null;
let lastMessageTime = null;
let currentUserId = null;

function startChat() {
  if (chatPollInterval) clearInterval(chatPollInterval);
  loadMessages(true); // full load first
  chatPollInterval = setInterval(() => loadMessages(false), 3000);
}

function stopChat() {
  if (chatPollInterval) { clearInterval(chatPollInterval); chatPollInterval = null; }
}

async function loadMessages(fullLoad = false) {
  try {
    const url = fullLoad || !lastMessageTime
      ? `/api/trips/${trip.id}/messages`
      : `/api/trips/${trip.id}/messages?since=${encodeURIComponent(lastMessageTime)}`;
    const msgs = await api(url);
    if (!msgs.length && !fullLoad) return;

    const box = document.getElementById('chatMessages');
    if (!box) return;

    if (fullLoad) {
      box.innerHTML = msgs.length ? '' : '<div class="chat-empty">No messages yet. Say hello to your group! 👋</div>';
    }

    msgs.forEach(m => {
      if (document.querySelector(`[data-msgid="${m.id}"]`)) return; // skip dupes
      const isMine = m.user_id === currentUserId;
      const time = new Date(m.created_at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      const div = document.createElement('div');
      div.className = `chat-msg ${isMine ? 'mine' : 'theirs'}`;
      div.dataset.msgid = m.id;
      div.innerHTML = `
        <div class="chat-avatar" style="background:${m.avatar_color}">${m.display_name.slice(0,1).toUpperCase()}</div>
        <div class="chat-bubble">
          ${!isMine ? `<div class="chat-name">${escapeHtml(m.display_name)}</div>` : ''}
          <div class="chat-text">${escapeHtml(m.body)}</div>
          <div class="chat-time">${time}</div>
        </div>`;
      box.appendChild(div);
      lastMessageTime = m.created_at;
    });

    if (msgs.length || fullLoad) {
      box.scrollTop = box.scrollHeight;
    }
  } catch(e) { console.warn('Chat error:', e.message); }
}

async function sendMessage() {
  const input = document.getElementById('chatInput');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  input.disabled = true;
  try {
    await api(`/api/trips/${trip.id}/messages`, { method:'POST', body:{ body } });
    await loadMessages(false);
  } catch(e) { alert('Could not send message: ' + e.message); input.value = body; }
  finally { input.disabled = false; input.focus(); }
}

// ---------------- reservations ----------------
const RESY_CITY_CODES = {
  'new york': 'nyc', 'nyc': 'nyc', 'manhattan': 'nyc', 'brooklyn': 'nyc',
  'los angeles': 'la', 'la': 'la', 'hollywood': 'la', 'santa monica': 'la',
  'chicago': 'chi', 'san francisco': 'sf', 'miami': 'mia', 'miami beach': 'mia',
  'washington': 'dc', 'washington dc': 'dc', 'dc': 'dc',
  'boston': 'bos', 'las vegas': 'lv', 'seattle': 'sea', 'atlanta': 'atl',
  'houston': 'hou', 'dallas': 'dal', 'denver': 'den', 'portland': 'pdx',
  'nashville': 'nas', 'austin': 'aus', 'philadelphia': 'phl', 'phoenix': 'phx',
  'san diego': 'sd', 'minneapolis': 'msp', 'new orleans': 'nola',
  'london': 'lon', 'paris': 'par', 'toronto': 'tor', 'montreal': 'mtl',
  'amsterdam': 'ams', 'barcelona': 'bcn', 'rome': 'rom', 'tokyo': 'tok'
};

function resyCityCode(cityName) {
  if (!cityName) return 'nyc';
  const key = cityName.toLowerCase().split(',')[0].trim();
  return RESY_CITY_CODES[key] || key.replace(/\s+/g, '-');
}

function reservationDate() {
  // Use trip start date or today
  if (trip && trip.start_date) return trip.start_date.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function partySize() {
  const el = document.getElementById('partySize');
  return el ? parseInt(el.value) || 2 : 2;
}

function openTableUrl(placeName, cityName) {
  const date = reservationDate();
  const term = encodeURIComponent(`${placeName}${cityName ? ', ' + cityName : ''}`);
  return `https://www.opentable.com/s/?term=${term}&covers=${partySize()}&dateTime=${date}T19%3A00`;
}

function resyUrl(placeName, cityName) {
  const date = reservationDate();
  const city = resyCityCode(cityName);
  const query = encodeURIComponent(placeName);
  return `https://resy.com/cities/${city}?query=${query}&date=${date}&seats=${partySize()}`;
}

function reservationBtnsHtml(placeName, cityName, category) {
  const cats = ['restaurant', 'bar', 'bar/nightlife', 'other'];
  if (!cats.includes((category || '').toLowerCase())) return '';
  return `
    <div class="reservation-btns">
      <a class="res-btn opentable-btn" href="${openTableUrl(placeName, cityName)}" target="_blank" rel="noopener">📅 OpenTable</a>
      <a class="res-btn resy-btn" href="${resyUrl(placeName, cityName)}" target="_blank" rel="noopener">📅 Resy</a>
    </div>`;
}

// ---------------- Chat send button
document.addEventListener('click', e => {
  if (e.target.id === 'chatSendBtn') sendMessage();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement.id === 'chatInput') sendMessage();
});

// ---------------- budget ----------------
document.getElementById('budgetCap').addEventListener('change', async (e) => {
  const cents = Math.round((parseFloat(e.target.value) || 0) * 100);
  await api(`/api/trips/${trip.id}`, { method:'PATCH', body:{ budget_cap_cents: cents } });
  trip.budget_cap_cents = cents;
  renderBudget();
});
function renderBudget() {
  const list = document.getElementById('budgetList');
  const total = (trip.places || []).reduce((s,p) => s + (p.estimated_cost_cents||0), 0);
  list.innerHTML = (trip.places || []).map(p => `<div class="budget-line"><span>${escapeHtml(p.name)}</span><span>${fmtMoney(p.estimated_cost_cents)}</span></div>`).join('') || '<div class="empty">No costs added yet.</div>';
  document.getElementById('budgetTotalRow').innerHTML = `<span>Total planned</span><span>${fmtMoney(total)}</span>`;
  const cap = trip.budget_cap_cents || 0;
  const pct = cap ? Math.min(100, (total/cap)*100) : 0;
  const fill = document.getElementById('budgetFill');
  fill.style.width = pct + '%';
  fill.classList.toggle('over', total > cap);
  document.getElementById('budgetHint').textContent = `${fmtMoney(total)} planned of ${fmtMoney(cap)}` + (total > cap ? ' — over budget' : '');
}

// ---------------- group / sharing ----------------
function renderMembers() {
  const members = trip.members || [];
  document.getElementById('memberList').innerHTML = members.map(m =>
    `<div class="member-chip"><span class="dot" style="background:${m.color||'#999'}"></span>${escapeHtml((m.users && m.users.display_name) || 'Traveler')}</div>`).join('') || '<div class="empty">Just you so far.</div>';
}

document.getElementById('shareBtn').addEventListener('click', async () => {
  const data = await api(`/api/trips/${trip.id}/share`, { method:'POST' });
  trip.share_code = data.shareCode;
  document.getElementById('shareCodeBox').innerHTML = `Share code: <b style="font-family:var(--mono);font-size:16px;letter-spacing:0.1em;">${data.shareCode}</b><br>Anyone who enters this code via "Join shared trip" sees this map and can add their own stops.`;
  document.querySelector('.tab[data-tab="group"]').click();
  alert('Share code generated: ' + data.shareCode + '\n\nGive this to your travel companions — they click "Join shared trip" and enter it.');
});

document.getElementById('joinBtn').addEventListener('click', async () => {
  const code = prompt('Enter the share code your travel companion gave you:');
  if (!code) return;
  try {
    const { trip: joined } = await api(`/api/share/${code.toUpperCase().trim()}/join`, { method:'POST' });
    await loadTrip(joined.id);
    await loadTripsList();
    alert('Joined trip: ' + joined.destination_city);
  } catch (e) { alert(e.message); }
});

document.getElementById('exportBtn').addEventListener('click', () => {
  document.querySelector('.tab[data-tab="itinerary"]').click();
  window.print();
});

// ---------------- trip lifecycle ----------------
async function loadTripsList() {
  myTrips = await api('/api/trips');
  populateTripSwitcher();
}
function populateTripSwitcher() {
  const sw = document.getElementById('tripSwitcher');
  sw.innerHTML = myTrips.map(t => `<option value="${t.id}" ${trip && t.id===trip.id ? 'selected':''}>${escapeHtml(t.name)} — ${escapeHtml(t.destination_city)}</option>`).join('');
}
document.getElementById('tripSwitcher').addEventListener('change', (e) => loadTrip(e.target.value));

async function loadTrip(id) {
  trip = await api(`/api/trips/${id}`);
  hydrateUIFromTrip();
}

document.getElementById('newTripBtn').addEventListener('click', () => promptNewTrip());
async function promptNewTrip() {
  const name = prompt('Trip name:', 'My Trip');
  if (!name) return;
  const city = prompt('Destination city:', 'Amsterdam, Netherlands');
  if (!city) return;
  const created = await api('/api/trips', { method:'POST', body:{ name, destinationCity: city, pace:'moderate', transportMode:'driving', budgetCapCents: 80000 } });
  await loadTripsList();
  await loadTrip(created.id);
}

function hydrateUIFromTrip() {
  document.getElementById('tripNameInput').value = trip.name || '';
  document.getElementById('cityInput').value = trip.destination_city || '';
  document.getElementById('startDate').value = trip.start_date || '';
  document.getElementById('endDate').value = trip.end_date || '';
  document.getElementById('emergencyNum').value = trip.emergency_number || '';
  document.getElementById('embassyInfo').value = trip.embassy_info || '';
  document.getElementById('budgetCap').value = ((trip.budget_cap_cents||0)/100).toFixed(0);

  document.querySelectorAll('#pacePills .pill').forEach(p => p.classList.toggle('active', p.dataset.pace === trip.pace));
  document.querySelectorAll('#modePills .pill').forEach(p => p.classList.toggle('active', p.dataset.mode === trip.transport_mode));

  const base = primaryBase();
  if (hotelMarker) { map.removeLayer(hotelMarker); hotelMarker = null; }
  if (base) {
    document.getElementById('hotelInput').value = base.name;
    document.getElementById('hotelStatus').textContent = 'Located: ' + (base.address || '');
    hotelMarker = L.marker([base.lat, base.lng], { icon: hotelIcon() }).addTo(map).bindPopup('<b>🏨 Home base</b>');
  } else {
    document.getElementById('hotelInput').value = '';
    document.getElementById('hotelStatus').textContent = 'Not located yet — click "Locate on map".';
  }

  document.getElementById('shareCodeBox').innerHTML = trip.share_code
    ? `Share code: <b style="font-family:var(--mono);font-size:16px;">${trip.share_code}</b>`
    : 'Not shared yet. Click "Share trip" above to generate a code.';

  document.getElementById('itineraryOutput').innerHTML = '<div class="empty">Add your hotel and at least one place, then calculate.</div>';
  document.getElementById('mapStatDistance').textContent = '— total distance';
  document.getElementById('mapStatTime').textContent = '— travel time';

  renderPlaces(); redrawMarkers(); fitAll(); renderBudget(); renderMembers();
  // Load POIs for this trip's destination
  if (trip.destination_lat && trip.destination_lng) {
    loadCityPOIs(trip.destination_lat, trip.destination_lng, 3000);
  }
}

// ---------------- bootstrap ----------------
async function boot() {
  authMask.style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if (!map) initMap();
  // Capture current user ID for chat
  try {
    const stored = localStorage.getItem('waypoint_user');
    if (stored) { const u = JSON.parse(stored); currentUserId = u.id; }
  } catch(e) {}

  // City autocomplete — filter to cities/places
  setupAutocomplete('cityInput', 'cityAutocomplete', async (s) => {
    document.getElementById('cityInput').value = s.label;
    // Auto-save destination and load POIs
    if (trip) {
      try {
        const updated = await api(`/api/trips/${trip.id}`, {
          method: 'PATCH',
          body: { destination_city: s.label, destination_lat: s.lat, destination_lng: s.lng }
        });
        Object.assign(trip, updated);
        map.setView([s.lat, s.lng], 13);
        loadCityPOIs(s.lat, s.lng, 3000);
      } catch(e) { console.warn('Could not save destination:', e.message); }
    }
  }, 'city');

  // Hotel autocomplete — all place types
  setupAutocomplete('hotelInput', 'hotelAutocomplete', async (s) => {
    document.getElementById('hotelInput').value = s.label;
    // Auto-trigger hotel locate with the selected address
    const statusEl = document.getElementById('hotelStatus');
    statusEl.textContent = 'Locating…';
    try {
      const base = await api(`/api/trips/${trip.id}/base`, {
        method: 'POST',
        body: { name: s.name || s.label, address: s.label, checkIn: document.getElementById('startDate').value || null, checkOut: document.getElementById('endDate').value || null }
      });
      trip.bases = [base, ...(trip.bases || []).filter(b => !b.is_primary)];
      if (hotelMarker) map.removeLayer(hotelMarker);
      hotelMarker = L.marker([base.lat, base.lng], { icon: hotelIcon() }).addTo(map)
        .bindPopup('<b>🏨 ' + (s.name || s.label) + '</b><br>Home base');
      map.setView([base.lat, base.lng], 15);
      statusEl.textContent = 'Located: ' + base.address;
    } catch(e) { statusEl.textContent = e.message; }
  }, 'all');

  loadCelebrityPicks();
  try {
    await loadTripsList();
    if (!myTrips.length) { await promptNewTrip(); }
    else { await loadTrip(myTrips[0].id); }
  } catch (e) {
    const msg = e.message.includes('Failed to fetch')
      ? 'Cannot reach the server — it may be waking up (free tier cold start takes ~60s). Refresh and try again.'
      : 'Could not load your trips: ' + e.message;
    alert(msg);
  }
}

// Catch any unhandled promise rejections so the app doesn't silently die
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason);
});

(function start() {
  if (token) { boot(); }
  else { authMask.style.display = 'flex'; }
})();
