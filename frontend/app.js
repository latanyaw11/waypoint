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
  map = L.map('map', { zoomControl: true }).setView([52.3676, 4.9041], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}
function numIcon(n) { return L.divIcon({ className:'', html:`<div class="num-pin"><span>${n}</span></div>`, iconSize:[26,26], iconAnchor:[13,26] }); }
function hotelIcon() { return L.divIcon({ className:'', html:`<div class="hotel-pin">🏨</div>`, iconSize:[30,30], iconAnchor:[15,15] }); }

function redrawMarkers() {
  placeMarkers.forEach(m => map.removeLayer(m));
  placeMarkers = [];
  (trip.places || []).forEach((p, i) => {
    const order = (p.route_position) ? p.route_position : i + 1;
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
  });
});

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
    document.querySelectorAll('#categoryPills .pill').forEach(x => x.classList.remove('active'));
    p.classList.add('active'); activeCategory = p.dataset.cat;
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
      <div class="actions"><button class="iconbtn" data-remove="${p.id}">Remove</button></div>
    </div>`).join('');

  // Toggle handlers
  document.getElementById('useOptimized').addEventListener('click', () => { manualOrder = false; renderPlaces(); redrawMarkers(); });
  document.getElementById('useManual').addEventListener('click', () => { manualOrder = true; renderPlaces(); });

  // Remove handlers
  list.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api(`/api/trips/${trip.id}/places/${btn.dataset.remove}`, { method:'DELETE' });
      trip.places = trip.places.filter(p => p.id !== btn.dataset.remove);
      renderPlaces(); redrawMarkers(); renderBudget();
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

// ---------------- celebrity tab ----------------
async function loadCelebrityPicks() {
  try {
    const picks = await api('/api/celebrity-picks');
    const list = document.getElementById('celebList');
    if (!picks.length) { list.innerHTML = '<div class="empty">No celebrity picks published yet — add some from the admin panel.</div>'; return; }
    list.innerHTML = picks.map((c, i) => `
      <div class="celeb-card">
        <div class="who">${escapeHtml(c.celebrity_name)}</div>
        <h4>${escapeHtml(c.place_name)}</h4>
        <div class="city">${escapeHtml(c.city)} ${catTagHtml(c.category)}</div>
        <p>${escapeHtml(c.note || '')}</p>
        <button class="btn btn-gold btn-small" data-addceleb="${i}">Add to my places</button>
      </div>`).join('');
    list.querySelectorAll('[data-addceleb]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const c = picks[btn.dataset.addceleb];
        const place = await api(`/api/trips/${trip.id}/places`, {
          method:'POST',
          body: { query: `${c.place_name}, ${c.city}`, name: c.place_name, category: c.category || 'restaurant', notes: c.note, visitDurationMin: 75, estimatedCostCents: 2500, celebrityPickId: c.id }
        });
        trip.places = [...(trip.places || []), place];
        renderPlaces(); redrawMarkers(); fitAll(); renderBudget();
        document.querySelector('.tab[data-tab="places"]').click();
      });
    });
  } catch (e) { document.getElementById('celebList').innerHTML = `<div class="empty">${e.message}</div>`; }
}

// ---------------- itinerary / routing ----------------
document.getElementById('optimizeBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('optimizeStatus');
  await ensureBases();
  const base = primaryBase();
  if (!base) { statusEl.textContent = 'Set your hotel location in Setup first.'; return; }
  if (!trip.places || !trip.places.length) { statusEl.textContent = 'Add at least one place first.'; return; }
  statusEl.textContent = 'Calculating shortest route…';
  try {
    const result = await api(`/api/trips/${trip.id}/routing/calculate`, { method:'POST' });
    lastItinerary = result;
    document.getElementById('mapStatDistance').textContent = (result.totalDistanceM/1000).toFixed(1) + ' km total';
    document.getElementById('mapStatTime').textContent = Math.round(result.totalDurationS/60) + ' min travel';

    // refresh place list with persisted day/route_position for marker numbering
    trip.places = await api(`/api/trips/${trip.id}/places`);
    redrawMarkers();

    const profile = trip.transport_mode === 'walking' ? 'foot' : 'driving';
    const flat = result.days.flatMap(d => d.stops);
    const geomPoints = [{ lat: base.lat, lng: base.lng }, ...flat.map(s => ({ lat:s.lat, lng:s.lng }))];
    const geom = await osrmRouteGeometry(geomPoints, profile);
    drawRouteLine(geom);

    renderItinerary(result, base);
    statusEl.textContent = `Route calculated — ${flat.length} stops sequenced (${result.routeSource === 'osrm' ? 'live routing' : 'straight-line estimate'}).`;
  } catch (e) { statusEl.textContent = e.message; }
});

function renderItinerary(result, base) {
  let html = '';
  let prevId = 'base';
  result.days.forEach(day => {
    html += `<div class="daygroup"><div class="dayhead">Day ${day.day} <span class="badge">${day.stops.length} stop${day.stops.length>1?'s':''}</span></div>`;
    day.stops.forEach(stop => {
      const distKm = (stop.legDistanceM/1000).toFixed(1);
      const minutes = Math.round(stop.legDurationS/60);
      html += `<div class="legrow"><span>↳ ${distKm} km</span><span class="dots"></span><span>${minutes} min</span></div>`;
      html += `<div class="stopcard" style="margin-bottom:10px;">
        <div class="meta">${catTagHtml(stop.category)} <span>${stop.visitDurationMin||60} min visit</span></div>
        <h4>${escapeHtml(stop.name)}</h4>
        <div class="hint">${escapeHtml(stop.address||'')}</div>
        <button class="uberbtn" data-from="${prevId}" data-to="${stop.id}">🚗 Request Uber here</button>
      </div>`;
      prevId = stop.id;
    });
    html += `</div>`;
  });
  document.getElementById('itineraryOutput').innerHTML = html || '<div class="empty">Nothing to show yet.</div>';
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
}

// ---------------- bootstrap ----------------
async function boot() {
  authMask.style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if (!map) initMap();
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
