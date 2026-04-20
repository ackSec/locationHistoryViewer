/* MapLibre layer setup + per-frame rendering updates. */

const LHRender = (() => {

  const COLORS = {
    WALKING: '#4ade80',
    RUNNING: '#a3e635',
    CYCLING: '#22d3ee',
    DRIVING: '#fb923c',
    MOTORCYCLING: '#fb923c',
    BUS: '#fb923c',
    RAIL: '#f59e0b',
    BOATING: '#38bdf8',
    FLYING: '#e879f9',
    UNKNOWN: '#94a3b8',
  };

  const EMPTY_FC = { type: 'FeatureCollection', features: [] };

  // === Great-circle arc sampler for flight segments ===
  // Slerp on the unit sphere between two lat/lng points, nSamples along the path.
  function arcCoords(a, b, nSamples = 64) {
    const toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    const la1 = a.lat * toRad, lo1 = a.lng * toRad;
    const la2 = b.lat * toRad, lo2 = b.lng * toRad;
    const d = 2 * Math.asin(Math.sqrt(
      Math.sin((la2 - la1) / 2) ** 2 +
      Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2
    ));
    if (d === 0) return [[a.lng, a.lat], [b.lng, b.lat]];
    const out = [];
    for (let i = 0; i <= nSamples; i++) {
      const f = i / nSamples;
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x = A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const y = A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const z = A * Math.sin(la1) + B * Math.sin(la2);
      const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg;
      const lng = Math.atan2(y, x) * toDeg;
      out.push([lng, lat]);
    }
    return out;
  }

  // Build a "lift" altitude for flight arc (visual only — we just use line-width pulse to suggest height).
  // Actually rendered as a 2D arc; we rely on the curve shape across the map for a "wow" effect.

  function buildTrailGeoJSON(data) {
    const features = [];
    for (const s of data.segments) {
      if (s.isFlight) continue; // flights go in a separate source
      const coords = (s.points && s.points.length >= 2)
        ? s.points.map(p => [p.lng, p.lat])
        : [[s.startLng, s.startLat], [s.endLng, s.endLat]];
      features.push({
        type: 'Feature',
        properties: { t0: s.t0, t1: s.t1, type: s.type, conf: s.confidence },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function buildArcGeoJSON(data) {
    const features = [];
    for (const s of data.segments) {
      if (!s.isFlight) continue;
      const coords = arcCoords({ lat: s.startLat, lng: s.startLng }, { lat: s.endLat, lng: s.endLng }, 64);
      features.push({
        type: 'Feature',
        properties: { t0: s.t0, t1: s.t1, type: s.type },
        geometry: { type: 'LineString', coordinates: coords },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function buildVisitGeoJSON(data) {
    const features = [];
    for (const v of data.visits) {
      features.push({
        type: 'Feature',
        properties: {
          t0: v.t0, t1: v.t1,
          name: v.name || '',
          duration: v.t1 - v.t0,
          isLong: (v.t1 - v.t0) > 1000 * 60 * 60 * 6, // > 6h
        },
        geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function buildGapGeoJSON(data) {
    const features = [];
    for (const g of data.gaps) {
      features.push({
        type: 'Feature',
        properties: { t0: g.t0, t1: g.t1 },
        geometry: { type: 'LineString', coordinates: [[g.from.lng, g.from.lat], [g.to.lng, g.to.lat]] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function buildHomeBaseGeoJSON(data) {
    const features = [];
    for (const h of data.homeBase) {
      features.push({
        type: 'Feature',
        properties: {
          t0: Date.UTC(h.year, 0, 1),
          t1: Date.UTC(h.year + 1, 0, 1),
          name: h.name,
          year: h.year,
        },
        geometry: { type: 'Point', coordinates: [h.lng, h.lat] },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  // === Layers ===

  function addLayers(map) {
    map.addSource('trail',        { type: 'geojson', data: EMPTY_FC });
    map.addSource('arcs',         { type: 'geojson', data: EMPTY_FC });
    map.addSource('visits',       { type: 'geojson', data: EMPTY_FC });
    map.addSource('gaps',         { type: 'geojson', data: EMPTY_FC });
    map.addSource('home-bases',   { type: 'geojson', data: EMPTY_FC });
    map.addSource('playhead',     { type: 'geojson', data: EMPTY_FC });

    const typeColorExpr = [
      'match', ['get', 'type'],
      'WALKING',      COLORS.WALKING,
      'RUNNING',      COLORS.RUNNING,
      'CYCLING',      COLORS.CYCLING,
      'DRIVING',      COLORS.DRIVING,
      'BUS',          COLORS.BUS,
      'MOTORCYCLING', COLORS.MOTORCYCLING,
      'RAIL',         COLORS.RAIL,
      'BOATING',      COLORS.BOATING,
      'FLYING',       COLORS.FLYING,
      COLORS.UNKNOWN,
    ];

    // home base pulse halo
    map.addLayer({
      id: 'home-halo',
      type: 'circle',
      source: 'home-bases',
      paint: {
        'circle-radius': 30,
        'circle-color': '#facc15',
        'circle-opacity': 0,
        'circle-blur': 1,
      },
    });
    map.addLayer({
      id: 'home-core',
      type: 'circle',
      source: 'home-bases',
      paint: {
        'circle-radius': 4,
        'circle-color': '#facc15',
        'circle-opacity': 0,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0,
      },
    });

    // gaps (dashed)
    map.addLayer({
      id: 'gaps',
      type: 'line',
      source: 'gaps',
      paint: {
        'line-color': '#64748b',
        'line-width': 1,
        'line-dasharray': [2, 3],
        'line-opacity': 0,
      },
    });

    // trail glow (bottom)
    map.addLayer({
      id: 'trail-glow',
      type: 'line',
      source: 'trail',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': typeColorExpr,
        'line-width': 10,
        'line-opacity': 0,
        'line-blur': 5,
      },
    });
    map.addLayer({
      id: 'trail',
      type: 'line',
      source: 'trail',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': typeColorExpr,
        'line-width': 2.5,
        'line-opacity': 0,
      },
    });

    // arcs glow + line
    map.addLayer({
      id: 'arcs-glow',
      type: 'line',
      source: 'arcs',
      paint: {
        'line-color': COLORS.FLYING,
        'line-width': 6,
        'line-opacity': 0,
        'line-blur': 4,
      },
    });
    map.addLayer({
      id: 'arcs',
      type: 'line',
      source: 'arcs',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': COLORS.FLYING,
        'line-width': 1.5,
        'line-opacity': 0,
      },
    });

    // visits
    map.addLayer({
      id: 'visits',
      type: 'circle',
      source: 'visits',
      paint: {
        'circle-radius': ['case', ['get', 'isLong'], 3.5, 2],
        'circle-color': '#22d3ee',
        'circle-opacity': 0,
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 0.5,
        'circle-stroke-opacity': 0,
      },
    });

    // playhead — bright, pulsing, unmistakable at world zoom
    map.addLayer({
      id: 'playhead-halo',
      type: 'circle',
      source: 'playhead',
      paint: {
        'circle-radius': 55,
        'circle-color': '#22d3ee',
        'circle-opacity': 0.22,
        'circle-blur': 1,
      },
    });
    map.addLayer({
      id: 'playhead-ring',
      type: 'circle',
      source: 'playhead',
      paint: {
        'circle-radius': 22,
        'circle-color': 'transparent',
        'circle-stroke-color': '#22d3ee',
        'circle-stroke-width': 2,
        'circle-stroke-opacity': 0.9,
      },
    });
    map.addLayer({
      id: 'playhead',
      type: 'circle',
      source: 'playhead',
      paint: {
        'circle-radius': 10,
        'circle-color': '#fff',
        'circle-stroke-color': '#22d3ee',
        'circle-stroke-width': 3,
      },
    });
  }

  function loadData(map, data) {
    map.getSource('trail').setData(buildTrailGeoJSON(data));
    map.getSource('arcs').setData(buildArcGeoJSON(data));
    map.getSource('visits').setData(buildVisitGeoJSON(data));
    map.getSource('gaps').setData(buildGapGeoJSON(data));
    map.getSource('home-bases').setData(buildHomeBaseGeoJSON(data));
    map.getSource('playhead').setData(EMPTY_FC);
  }

  // === Per-frame updates ===

  // Simplified opacity expression: visible after t0, fully opaque while active,
  // drops to a dim "history" level after t1. Avoids the per-feature interpolate
  // across two time domains which was expensive to evaluate for 4k+ features
  // 60 times per second.
  function trailOpacityExpr(currentTime, opts = {}) {
    const active = opts.active || 0.95;
    const past   = opts.past   || 0.38;
    return [
      'case',
      ['>', ['get', 't0'], currentTime], 0,
      ['<=', ['get', 't1'], currentTime], past,
      active,
    ];
  }

  function visitOpacityExpr(currentTime) {
    return [
      'case',
      ['>', ['get', 't0'], currentTime], 0,
      ['<=', ['get', 't1'], currentTime], 0.5,
      1.0,
    ];
  }

  function homeBaseOpacityExpr(currentTime) {
    // visible only during that year
    return [
      'case',
      ['all', ['<=', ['get', 't0'], currentTime], ['>', ['get', 't1'], currentTime]],
        0.9,
      0,
    ];
  }

  function updateFrame(map, currentTime) {
    map.setPaintProperty('trail',      'line-opacity', trailOpacityExpr(currentTime));
    map.setPaintProperty('trail-glow', 'line-opacity', trailOpacityExpr(currentTime, { active: 0.7, floor: 0.06 }));
    map.setPaintProperty('arcs',       'line-opacity', trailOpacityExpr(currentTime, { active: 0.9 }));
    map.setPaintProperty('arcs-glow',  'line-opacity', trailOpacityExpr(currentTime, { active: 0.6, floor: 0.04 }));
    map.setPaintProperty('visits',     'circle-opacity', visitOpacityExpr(currentTime));
    map.setPaintProperty('visits',     'circle-stroke-opacity', visitOpacityExpr(currentTime));
    map.setPaintProperty('gaps',       'line-opacity',
      ['case', ['>', ['get', 't0'], currentTime], 0, 0.25]);
    map.setPaintProperty('home-halo',  'circle-opacity', homeBaseOpacityExpr(currentTime));
    map.setPaintProperty('home-core',  'circle-opacity', homeBaseOpacityExpr(currentTime));
    map.setPaintProperty('home-core',  'circle-stroke-opacity', homeBaseOpacityExpr(currentTime));
  }

  function setPlayhead(map, pos) {
    const src = map.getSource('playhead');
    if (!src) return;
    if (!pos) { src.setData(EMPTY_FC); return; }
    src.setData({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] },
      }],
    });
  }

  return { addLayers, loadData, updateFrame, setPlayhead, COLORS };
})();
