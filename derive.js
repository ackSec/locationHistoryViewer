/* Derive extra structures used at render time:
 *   t0, t1           — overall time bounds
 *   timeline         — merged visits+segments sorted by start (for "what's active now" lookups)
 *   gaps             — time+distance gaps between adjacent events (rendered dashed)
 *   events           — year changes, country entries, home-base moves (drive banner)
 *   cumulative       — sparse cumulative stats by end-time (drive live HUD)
 *   homeBase         — per-year most-visited named place
 */

const LHDerive = (() => {

  const GAP_MS = 6 * 3600 * 1000;   // 6 hours of silence → gap candidate
  const GAP_KM = 5;                 // only draw gap line if the two endpoints are > 5 km apart

  function haversineKm(a, b) {
    const R = 6371, toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLng = (b.lng - a.lng) * toRad;
    const la1 = a.lat * toRad, la2 = b.lat * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function segmentKm(s) {
    if (s.distance && s.distance > 0) return s.distance / 1000;
    return haversineKm({ lat: s.startLat, lng: s.startLng }, { lat: s.endLat, lng: s.endLng });
  }

  // start/end coordinates of any timeline entry (used for gap endpoints)
  function locOf(parsed, entry, which) {
    if (entry.kind === 'visit') {
      const v = parsed.visits[entry.i];
      return { lat: v.lat, lng: v.lng };
    }
    const s = parsed.segments[entry.i];
    if (which === 'start') return { lat: s.startLat, lng: s.startLng };
    return { lat: s.endLat, lng: s.endLng };
  }

  // Compute the home base for each year: the named place where the most wall-clock time was spent.
  function computeHomeBase(visits) {
    const byYear = new Map(); // year -> Map(key -> {dur, name, lat, lng, country})
    for (const v of visits) {
      if (!v.name) continue;
      const year = new Date(v.t0).getUTCFullYear();
      if (!byYear.has(year)) byYear.set(year, new Map());
      const bucket = byYear.get(year);
      const key = v.name + '|' + v.lat.toFixed(2) + ',' + v.lng.toFixed(2);
      const prev = bucket.get(key) || { dur: 0, name: v.name, lat: v.lat, lng: v.lng, country: v.country };
      prev.dur += Math.max(0, v.t1 - v.t0);
      bucket.set(key, prev);
    }
    const result = []; // sorted by year
    const years = [...byYear.keys()].sort((a, b) => a - b);
    for (const y of years) {
      const bucket = byYear.get(y);
      let best = null;
      for (const v of bucket.values()) if (!best || v.dur > best.dur) best = v;
      if (best && best.dur > 1000 * 60 * 60 * 24 * 3) { // must be at least 3 days total
        result.push({ year: y, ...best });
      }
    }
    return result;
  }

  function derive(parsed) {
    parsed.visits.sort((a, b) => a.t0 - b.t0);
    parsed.segments.sort((a, b) => a.t0 - b.t0);
    parsed.rawPoints.sort((a, b) => a.t - b.t);

    const starts = [];
    const ends = [];
    if (parsed.visits.length) { starts.push(parsed.visits[0].t0); ends.push(parsed.visits[parsed.visits.length - 1].t1); }
    if (parsed.segments.length) { starts.push(parsed.segments[0].t0); ends.push(parsed.segments[parsed.segments.length - 1].t1); }
    if (parsed.rawPoints.length) { starts.push(parsed.rawPoints[0].t); ends.push(parsed.rawPoints[parsed.rawPoints.length - 1].t); }
    const t0 = starts.length ? Math.min(...starts) : 0;
    const t1 = ends.length ? Math.max(...ends) : 0;

    // merged chronological timeline
    const timeline = [];
    parsed.visits.forEach((v, i) => timeline.push({ kind: 'visit', i, t0: v.t0, t1: v.t1 }));
    parsed.segments.forEach((s, i) => timeline.push({ kind: 'segment', i, t0: s.t0, t1: s.t1 }));
    timeline.sort((a, b) => a.t0 - b.t0);

    // gaps
    const gaps = [];
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const curr = timeline[i];
      if (curr.t0 - prev.t1 <= GAP_MS) continue;
      const a = locOf(parsed, prev, 'end');
      const b = locOf(parsed, curr, 'start');
      const km = haversineKm(a, b);
      if (km < GAP_KM) continue;
      gaps.push({ t0: prev.t1, t1: curr.t0, from: a, to: b, km });
    }

    // events + cumulative stats (iterated by end-time)
    const statsTimeline = [];
    parsed.visits.forEach((v) => statsTimeline.push({ kind: 'visit', t: v.t1, ref: v }));
    parsed.segments.forEach((s) => statsTimeline.push({ kind: 'segment', t: s.t1, ref: s }));
    statsTimeline.sort((a, b) => a.t - b.t);

    const events = [];
    const cumulative = [];
    const countries = new Set();
    const places = new Set();
    const yearsSeen = new Set();
    let km = 0, flights = 0, lastCountry = null;

    for (const ent of statsTimeline) {
      const year = new Date(ent.t).getUTCFullYear();
      if (!yearsSeen.has(year)) {
        yearsSeen.add(year);
        events.push({ t: ent.t, type: 'year', text: String(year) });
      }
      if (ent.kind === 'visit') {
        const v = ent.ref;
        if (v.country) {
          if (!countries.has(v.country)) {
            countries.add(v.country);
            events.push({ t: v.t0, type: 'country-new', text: v.country, sub: `Country ${countries.size}` });
          } else if (lastCountry && lastCountry !== v.country) {
            events.push({ t: v.t0, type: 'country-change', text: v.country, sub: 'Arrived' });
          }
          lastCountry = v.country;
        }
        if (v.name) places.add(v.name);
      } else {
        const s = ent.ref;
        km += segmentKm(s);
        if (s.isFlight) flights++;
      }
      cumulative.push({ t: ent.t, km, flights, countries: countries.size, places: places.size });
    }

    const homeBase = computeHomeBase(parsed.visits);
    let prevHomeBase = null;
    for (const h of homeBase) {
      if (!prevHomeBase || prevHomeBase.name !== h.name) {
        events.push({ t: Date.UTC(h.year, 0, 1), type: 'home-base', text: h.name, sub: 'Home base' });
      }
      prevHomeBase = h;
    }
    events.sort((a, b) => a.t - b.t);

    return { ...parsed, t0, t1, timeline, gaps, events, cumulative, homeBase, segmentKm: segmentKm };
  }

  // binary-search the last cumulative entry with t <= currentTime
  function statsAt(cumulative, currentTime) {
    if (!cumulative.length || currentTime < cumulative[0].t) {
      return { km: 0, flights: 0, countries: 0, places: 0 };
    }
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumulative[mid].t <= currentTime) lo = mid; else hi = mid - 1;
    }
    return cumulative[lo];
  }

  // linear-interp a position within a segment
  function positionAt(segment, t) {
    const pts = segment.points;
    if (!pts || !pts.length) return { lat: segment.startLat, lng: segment.startLng };
    if (t <= pts[0].t) return { lat: pts[0].lat, lng: pts[0].lng };
    if (t >= pts[pts.length - 1].t) return { lat: pts[pts.length - 1].lat, lng: pts[pts.length - 1].lng };
    // binary search for bracketing pair
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const f = (t - a.t) / Math.max(1, b.t - a.t);
    return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
  }

  return { derive, haversineKm, statsAt, positionAt, segmentKm };
})();
