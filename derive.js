/* Derive extra structures used at render time:
 *   t0, t1           — overall time bounds
 *   timeline         — merged visits+segments sorted by start (for "what's active now" lookups)
 *   gaps             — time+distance gaps between adjacent events (rendered dashed)
 *   events           — year changes, country entries, home-base moves (drive banner)
 *   cumulative       — sparse cumulative stats by end-time (drive live HUD)
 *   homeBase         — per-year most-visited named place
 */

const LHDerive = (() => {

  const GAP_MS = 6 * 3600 * 1000;     // 6 hours of silence → gap candidate
  const GAP_KM = 5;                   // only draw gap line if the two endpoints are > 5 km apart
  const BIG_GAP_MS = 30 * 86400000;   // 30 days → auto-skip during playback
  const RAW_MIN_DT_MS = 2 * 60 * 1000;    // downsample raw pings: keep if > 2 min apart
  const RAW_MIN_KM = 0.1;                 // ... OR > 100 m apart
  const RAW_TRIP_BREAK_MS = 30 * 60 * 1000; // raw ping gap > 30 min → end current trip
  const RAW_TRIP_BREAK_KM = 5;              // raw ping jump > 5 km → end current trip
  const RAW_ACCURACY_LIMIT = 200;          // drop pings with accuracy > 200 m

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

  // Synthesize trips from raw GPS pings:
  //   1. drop poor-accuracy pings
  //   2. downsample by time AND distance
  //   3. split into trips on big gaps (time or distance)
  //   4. emit each trip as an UNKNOWN-type segment
  function synthesizeSegmentsFromRaw(rawPoints) {
    if (!rawPoints.length) return [];
    const kept = [];
    let lastKept = null;
    for (const p of rawPoints) {
      if (p.accuracy && p.accuracy > RAW_ACCURACY_LIMIT) continue;
      if (!lastKept) { kept.push(p); lastKept = p; continue; }
      const dt = p.t - lastKept.t;
      const dkm = haversineKm(lastKept, p);
      if (dt >= RAW_MIN_DT_MS || dkm >= RAW_MIN_KM) {
        kept.push(p);
        lastKept = p;
      }
    }

    const segments = [];
    let buf = [];
    const flushTrip = () => {
      if (buf.length >= 2) {
        const first = buf[0], last = buf[buf.length - 1];
        let pathKm = 0;
        for (let i = 1; i < buf.length; i++) pathKm += haversineKm(buf[i - 1], buf[i]);
        segments.push({
          t0: first.t, t1: last.t,
          type: 'UNKNOWN',
          distance: pathKm * 1000, // meters
          confidence: 0.5,
          points: buf.map(p => ({ t: p.t, lat: p.lat, lng: p.lng })),
          startLat: first.lat, startLng: first.lng,
          endLat: last.lat, endLng: last.lng,
          isFlight: false,
          synthesized: true,
        });
      }
      buf = [];
    };
    for (const p of kept) {
      if (!buf.length) { buf.push(p); continue; }
      const last = buf[buf.length - 1];
      const dt = p.t - last.t;
      const dkm = haversineKm(last, p);
      if (dt > RAW_TRIP_BREAK_MS || dkm > RAW_TRIP_BREAK_KM) {
        flushTrip();
      }
      buf.push(p);
    }
    flushTrip();
    return segments;
  }

  function derive(parsed) {
    parsed.visits.sort((a, b) => a.t0 - b.t0);
    parsed.segments.sort((a, b) => a.t0 - b.t0);
    parsed.rawPoints.sort((a, b) => a.t - b.t);

    // Merge synthesized raw trips into segments so the legacy-records era renders as trails.
    if (parsed.rawPoints.length) {
      const synth = synthesizeSegmentsFromRaw(parsed.rawPoints);
      parsed.segments = parsed.segments.concat(synth);
      parsed.segments.sort((a, b) => a.t0 - b.t0);
    }

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

    // Contiguous data ranges — used by the playback loop to auto-skip long empty stretches.
    const dataRanges = [];
    if (timeline.length) {
      let curStart = timeline[0].t0;
      let curEnd = timeline[0].t1;
      for (let i = 1; i < timeline.length; i++) {
        const e = timeline[i];
        if (e.t0 - curEnd > BIG_GAP_MS) {
          dataRanges.push({ t0: curStart, t1: curEnd });
          curStart = e.t0;
          curEnd = e.t1;
        } else {
          curEnd = Math.max(curEnd, e.t1);
        }
      }
      dataRanges.push({ t0: curStart, t1: curEnd });
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

    return { ...parsed, t0, t1, timeline, gaps, events, cumulative, homeBase, dataRanges, segmentKm: segmentKm };
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
