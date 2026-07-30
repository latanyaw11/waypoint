const axios = require('axios');

/**
 * Routing service.
 * Defaults to OSRM (free, no key) for demo/dev. In production, swap the
 * `getMatrix` implementation for Google Distance Matrix API or Mapbox
 * Matrix API for better accuracy on transit/walking ETAs and live traffic.
 */

const OSRM_BASE = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';

function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function profileFor(mode) {
  if (mode === 'walking') return 'foot';
  if (mode === 'transit') return 'driving'; // OSRM has no public transit profile; swap for a transit API in prod
  return 'driving';
}

async function getMatrix(points, mode = 'driving') {
  const profile = profileFor(mode);
  try {
    const coordStr = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const { data } = await axios.get(
      `${OSRM_BASE}/table/v1/${profile}/${coordStr}`,
      { params: { annotations: 'distance,duration' }, timeout: 8000 }
    );
    if (data.code !== 'Ok') throw new Error('OSRM returned non-OK');
    return { distances: data.distances, durations: data.durations, source: 'osrm' };
  } catch (e) {
    // Fallback: haversine distance, assumed 30km/h average speed
    const n = points.length;
    const distances = Array.from({ length: n }, () => Array(n).fill(0));
    const durations = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const km = haversineKm(points[i], points[j]);
        distances[i][j] = km * 1000;
        durations[i][j] = (km / 30) * 3600;
      }
    }
    return { distances, durations, source: 'haversine_fallback' };
  }
}

/** Nearest-neighbor heuristic starting at index 0 (the hotel/base). */
function nearestNeighborOrder(distMatrix, startIdx = 0) {
  const n = distMatrix.length;
  const visited = new Set([startIdx]);
  const order = [startIdx];
  let current = startIdx;
  while (visited.size < n) {
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      if (distMatrix[current][j] < bestD) { bestD = distMatrix[current][j]; best = j; }
    }
    order.push(best);
    visited.add(best);
    current = best;
  }
  return order;
}

/** 2-opt local-search refinement on top of the nearest-neighbor order (keeps start fixed). */
function twoOptImprove(order, distMatrix) {
  let improved = true;
  const routeLength = (o) => {
    let sum = 0;
    for (let i = 0; i < o.length - 1; i++) sum += distMatrix[o[i]][o[i + 1]];
    return sum;
  };
  let best = order.slice();
  let bestLen = routeLength(best);
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const candidate = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const candidateLen = routeLength(candidate);
        if (candidateLen + 1e-6 < bestLen) {
          best = candidate; bestLen = candidateLen; improved = true;
        }
      }
    }
  }
  return best;
}

/** Splits an ordered stop list into days based on pace (stops/day cap). */
const PACE_STOPS = { relaxed: 3, moderate: 5, packed: 7 };

function splitIntoDays(orderedStops, pace = 'moderate') {
  const perDay = PACE_STOPS[pace] || 5;
  const days = [];
  for (let i = 0; i < orderedStops.length; i += perDay) {
    days.push(orderedStops.slice(i, i + perDay));
  }
  return days;
}

/** Full pipeline: base + places -> optimized, day-split itinerary with leg distances/durations. */
async function buildItinerary({ base, places, mode = 'driving', pace = 'moderate' }) {
  const points = [base, ...places];
  const { distances, durations, source } = await getMatrix(points, mode);
  let order = nearestNeighborOrder(distances, 0);
  order = twoOptImprove(order, distances);

  const orderedPoints = order.map((idx) => points[idx]);

  // Attach the leg (distance/duration FROM the previous stop) onto each point
  const legged = orderedPoints.map((pt, i) => {
    if (i === 0) return { ...pt, legDistanceM: 0, legDurationS: 0 };
    const fromIdx = order[i - 1], toIdx = order[i];
    return { ...pt, legDistanceM: distances[fromIdx][toIdx], legDurationS: durations[fromIdx][toIdx] };
  });

  const stops = legged.slice(1);
  const dayChunks = splitIntoDays(stops, pace);

  let totalDistanceM = 0, totalDurationS = 0;
  for (let i = 0; i < order.length - 1; i++) {
    totalDistanceM += distances[order[i]][order[i + 1]];
    totalDurationS += durations[order[i]][order[i + 1]];
  }

  return {
    routeSource: source,
    totalDistanceM,
    totalDurationS,
    orderedPlaceIds: stops.map((s) => s.id),
    days: dayChunks.map((day, i) => ({
      day: i + 1,
      stops: day.map((s) => ({
        id: s.id, name: s.name, category: s.category, lat: s.lat, lng: s.lng, address: s.address,
        visitDurationMin: s.visit_duration_min, estimatedCostCents: s.estimated_cost_cents,
        legDistanceM: s.legDistanceM, legDurationS: s.legDurationS,
      })),
    })),
  };
}

module.exports = { getMatrix, nearestNeighborOrder, twoOptImprove, splitIntoDays, buildItinerary, haversineKm, PACE_STOPS };
