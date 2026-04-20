/* Google Takeout Location History parser.
 * Handles three formats:
 *   (1) Legacy Records.json — raw points with accuracy, activity guesses
 *   (2) Legacy Semantic Location History/YYYY/YYYY_MONTH.json — placeVisit / activitySegment
 *   (3) New on-device format (2024+) — semanticSegments[] with visit / activity / timelinePath
 *
 * Output (normalized):
 *   {
 *     visits:   [{ t0, t1, lat, lng, name?, address?, country?, city?, semanticType?, confidence }],
 *     segments: [{ t0, t1, type, distance, confidence, points: [{t, lat, lng}], startLat, startLng, endLat, endLng, isFlight }],
 *     rawPoints: [{ t, lat, lng, accuracy }]   // only when no semantic data is present
 *   }
 *
 * All times are ms since epoch. Coordinates are decimal degrees.
 */

const LHParser = (() => {

  // ---------- coordinate helpers ----------

  function e7(v) { return v / 1e7; }

  // new format uses "37.7749°, -122.4194°" strings OR "geo:37.7749,-122.4194"
  function parseLatLngString(s) {
    if (!s) return null;
    if (typeof s === 'object' && s.latitude !== undefined) return { lat: s.latitude, lng: s.longitude };
    let str = String(s);
    if (str.startsWith('geo:')) str = str.slice(4);
    const m = str.match(/(-?\d+(?:\.\d+)?)[^\-\d]+(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
  }

  // accept E7 object, decimal object, or "lat°, lng°" string
  function readLocation(loc) {
    if (!loc) return null;
    if (typeof loc === 'string') return parseLatLngString(loc);
    if (loc.latE7 !== undefined && loc.lngE7 !== undefined) return { lat: e7(loc.latE7), lng: e7(loc.lngE7) };
    if (loc.latitudeE7 !== undefined && loc.longitudeE7 !== undefined) return { lat: e7(loc.latitudeE7), lng: e7(loc.longitudeE7) };
    if (loc.latLng) return parseLatLngString(loc.latLng);
    if (loc.placeLocation && loc.placeLocation.latLng) return parseLatLngString(loc.placeLocation.latLng);
    if (loc.latitude !== undefined && loc.longitude !== undefined) return { lat: loc.latitude, lng: loc.longitude };
    return null;
  }

  function parseTime(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'number') return v;
    if (/^\d+$/.test(String(v))) return parseInt(v, 10);
    const n = Date.parse(v);
    return isNaN(n) ? null : n;
  }

  // ---------- activity type normalization ----------

  // Map all known activity strings to a canonical label.
  function normalizeActivity(a) {
    if (!a) return 'UNKNOWN';
    const x = String(a).toUpperCase();
    if (x.includes('FLYING') || x.includes('AIRPLANE') || x === 'IN_FLIGHT') return 'FLYING';
    if (x.includes('WALKING') || x === 'ON_FOOT') return 'WALKING';
    if (x.includes('RUNNING')) return 'RUNNING';
    if (x.includes('CYCLING') || x.includes('BICYCLE') || x.includes('BIKING')) return 'CYCLING';
    if (x.includes('MOTORCYCL')) return 'MOTORCYCLING';
    if (x.includes('BOAT') || x.includes('SAIL') || x.includes('FERRY')) return 'BOATING';
    if (x.includes('TRAIN') || x.includes('RAIL') || x.includes('SUBWAY')) return 'RAIL';
    if (x.includes('BUS')) return 'BUS';
    if (x.includes('VEHICLE') || x.includes('DRIVING') || x.includes('CAR')) return 'DRIVING';
    return 'UNKNOWN';
  }

  function normalizeConfidence(c) {
    if (typeof c === 'number') return c;
    if (!c) return 0.5;
    const x = String(c).toUpperCase();
    if (x.includes('HIGH')) return 0.9;
    if (x.includes('MEDIUM')) return 0.6;
    if (x.includes('LOW')) return 0.3;
    return 0.5;
  }

  // ---------- address → country/city (cheap heuristic, address strings are comma-separated) ----------

  function parseAddress(addr) {
    if (!addr) return {};
    const parts = String(addr).split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) return {};
    const country = parts[parts.length - 1];
    // city usually 2nd or 3rd from end depending on format
    let city = null;
    if (parts.length >= 3) city = parts[parts.length - 3];
    else if (parts.length === 2) city = parts[0];
    return { country, city };
  }

  // ---------- individual format parsers ----------

  // (1) Legacy Records.json: { locations: [{ timestampMs, latitudeE7, longitudeE7, accuracy, activity? }] }
  function parseRecords(json, out) {
    const arr = json.locations || [];
    for (const r of arr) {
      // spec: coords outside ±900000000 E7 (lat) / ±1800000000 E7 (lng) are invalid
      if (r.latitudeE7 !== undefined && Math.abs(r.latitudeE7) > 900000000) continue;
      if (r.longitudeE7 !== undefined && Math.abs(r.longitudeE7) > 1800000000) continue;
      const loc = readLocation(r);
      if (!loc) continue;
      const t = parseTime(r.timestampMs || r.timestamp);
      if (t === null) continue;
      out.rawPoints.push({
        t,
        lat: loc.lat,
        lng: loc.lng,
        accuracy: r.accuracy || 50,
      });
    }
  }

  // (2) Legacy Semantic Location History per-month file.
  function parseSemanticMonth(json, out) {
    const arr = json.timelineObjects || [];
    for (const obj of arr) {
      if (obj.placeVisit) {
        const pv = obj.placeVisit;
        const loc = readLocation(pv.location) ||
                    readLocation({ latitudeE7: pv.centerLatE7, longitudeE7: pv.centerLngE7 });
        if (!loc) continue;
        const t0 = parseTime(pv.duration && (pv.duration.startTimestampMs || pv.duration.startTimestamp));
        const t1 = parseTime(pv.duration && (pv.duration.endTimestampMs || pv.duration.endTimestamp));
        if (t0 === null || t1 === null) continue;
        const addr = parseAddress(pv.location && pv.location.address);
        out.visits.push({
          t0, t1,
          lat: loc.lat, lng: loc.lng,
          name: pv.location && pv.location.name,
          address: pv.location && pv.location.address,
          country: addr.country, city: addr.city,
          semanticType: pv.location && pv.location.semanticType,
          confidence: normalizeConfidence(pv.placeConfidence || pv.visitConfidence),
        });
      } else if (obj.activitySegment) {
        const as = obj.activitySegment;
        const s = readLocation(as.startLocation);
        const e = readLocation(as.endLocation);
        if (!s || !e) continue;
        const t0 = parseTime(as.duration && (as.duration.startTimestampMs || as.duration.startTimestamp));
        const t1 = parseTime(as.duration && (as.duration.endTimestampMs || as.duration.endTimestamp));
        if (t0 === null || t1 === null) continue;
        const type = normalizeActivity(as.activityType);
        const points = [];
        // prefer simplifiedRawPath with timestamps; else waypointPath (no timestamps)
        if (as.simplifiedRawPath && as.simplifiedRawPath.points && as.simplifiedRawPath.points.length) {
          for (const p of as.simplifiedRawPath.points) {
            const pl = readLocation(p);
            if (!pl) continue;
            const pt = parseTime(p.timestampMs || p.timestamp);
            if (pt === null) continue;
            points.push({ t: pt, lat: pl.lat, lng: pl.lng });
          }
        } else if (as.waypointPath && as.waypointPath.waypoints && as.waypointPath.waypoints.length) {
          const wps = as.waypointPath.waypoints;
          const dt = (t1 - t0) / Math.max(1, wps.length - 1);
          wps.forEach((wp, i) => {
            const pl = readLocation(wp);
            if (!pl) return;
            points.push({ t: t0 + i * dt, lat: pl.lat, lng: pl.lng });
          });
        }
        if (!points.length) {
          points.push({ t: t0, lat: s.lat, lng: s.lng });
          points.push({ t: t1, lat: e.lat, lng: e.lng });
        }
        out.segments.push({
          t0, t1,
          type,
          distance: as.distance || as.distanceMeters || 0,
          confidence: normalizeConfidence(as.confidence),
          points,
          startLat: s.lat, startLng: s.lng,
          endLat: e.lat, endLng: e.lng,
          isFlight: type === 'FLYING',
        });
      }
    }
  }

  // Coerce stringified numbers ("0.95" → 0.95) that are common in iPhone Timeline exports.
  function numish(v, def) {
    if (v === undefined || v === null) return def;
    if (typeof v === 'number') return v;
    const n = parseFloat(v);
    return isFinite(n) ? n : def;
  }

  // (4) iPhone Timeline format (2024+): each entry has startTime/endTime and one of
  //     visit / activity / timelinePath. geo: strings, stringified numbers, placeID (no placeName).
  function parseIPhoneTimelineEntry(entry, out) {
    const t0 = parseTime(entry.startTime);
    const t1 = parseTime(entry.endTime);
    if (t0 === null || t1 === null) return;

    if (entry.visit) {
      const v = entry.visit;
      const cand = v.topCandidate || {};
      const loc = parseLatLngString(cand.placeLocation);
      if (!loc) return;
      const semanticType = cand.semanticType;
      // No place name or address in this format — use semanticType as a display label.
      const niceName = semanticType && semanticType !== 'Unknown' ? semanticType : null;
      out.visits.push({
        t0, t1,
        lat: loc.lat, lng: loc.lng,
        name: niceName,
        address: null,
        country: null, city: null,
        semanticType,
        placeId: cand.placeID,
        confidence: numish(v.probability, numish(cand.probability, 0.6)),
      });
      return;
    }
    if (entry.activity) {
      const a = entry.activity;
      const start = parseLatLngString(a.start);
      const end = parseLatLngString(a.end);
      if (!start || !end) return;
      const type = normalizeActivity(a.topCandidate && a.topCandidate.type);
      const points = [
        { t: t0, lat: start.lat, lng: start.lng },
        { t: t1, lat: end.lat, lng: end.lng },
      ];
      out.segments.push({
        t0, t1,
        type,
        distance: numish(a.distanceMeters, 0),
        confidence: numish(a.topCandidate && a.topCandidate.probability, numish(a.probability, 0.6)),
        points,
        startLat: start.lat, startLng: start.lng,
        endLat: end.lat, endLng: end.lng,
        isFlight: type === 'FLYING',
      });
      return;
    }
    if (Array.isArray(entry.timelinePath) && entry.timelinePath.length) {
      const points = [];
      for (const p of entry.timelinePath) {
        const pl = parseLatLngString(p.point);
        if (!pl) continue;
        const off = numish(p.durationMinutesOffsetFromStartTime, 0) * 60 * 1000;
        points.push({ t: t0 + off, lat: pl.lat, lng: pl.lng });
      }
      if (points.length >= 2) {
        out.segments.push({
          t0, t1,
          type: 'UNKNOWN',
          distance: 0,
          confidence: 0.5,
          points,
          startLat: points[0].lat, startLng: points[0].lng,
          endLat: points[points.length - 1].lat, endLng: points[points.length - 1].lng,
          isFlight: false,
        });
      }
    }
  }

  // (5) Consolidated envelope: { legacy_records: [...], timeline: [...] }
  function parseConsolidated(json, out) {
    if (Array.isArray(json.legacy_records)) {
      parseRecords({ locations: json.legacy_records }, out);
    }
    if (Array.isArray(json.timeline)) {
      for (const entry of json.timeline) parseIPhoneTimelineEntry(entry, out);
    }
  }

  // (3) Legacy "new" format (2024 Android on-device export).
  //   Top level: { semanticSegments: [...], rawSignals: [...] }
  //   Each semanticSegment has startTime, endTime, and one of: visit, activity, timelinePath.
  function parseTimelineNew(json, out) {
    const segs = json.semanticSegments || json.timelineObjects || [];
    for (const s of segs) {
      const t0 = parseTime(s.startTime);
      const t1 = parseTime(s.endTime);
      if (t0 === null || t1 === null) continue;

      if (s.visit) {
        const v = s.visit;
        const cand = v.topCandidate || {};
        const loc = readLocation(cand.placeLocation || cand) || readLocation(v);
        if (!loc) continue;
        out.visits.push({
          t0, t1,
          lat: loc.lat, lng: loc.lng,
          name: cand.placeName || cand.name,
          address: cand.address,
          country: (parseAddress(cand.address) || {}).country,
          city: (parseAddress(cand.address) || {}).city,
          semanticType: cand.semanticType,
          confidence: typeof v.probability === 'number' ? v.probability : normalizeConfidence(cand.probability),
        });
      } else if (s.activity) {
        const a = s.activity;
        const start = readLocation(a.start);
        const end = readLocation(a.end);
        if (!start || !end) continue;
        const type = normalizeActivity(a.topCandidate && a.topCandidate.type);
        const points = [];
        if (s.timelinePath && s.timelinePath.length) {
          for (const p of s.timelinePath) {
            const pl = parseLatLngString(p.point);
            if (!pl) continue;
            const off = parseFloat(p.durationMinutesOffsetFromStartTime || 0) * 60 * 1000;
            points.push({ t: t0 + off, lat: pl.lat, lng: pl.lng });
          }
        }
        if (!points.length) {
          points.push({ t: t0, lat: start.lat, lng: start.lng });
          points.push({ t: t1, lat: end.lat, lng: end.lng });
        }
        out.segments.push({
          t0, t1,
          type,
          distance: parseFloat(a.distanceMeters || 0),
          confidence: a.topCandidate && typeof a.topCandidate.probability === 'number' ? a.topCandidate.probability : 0.6,
          points,
          startLat: start.lat, startLng: start.lng,
          endLat: end.lat, endLng: end.lng,
          isFlight: type === 'FLYING',
        });
      } else if (s.timelinePath && s.timelinePath.length) {
        // standalone path without an activity wrapper — treat as unknown activity
        const points = [];
        for (const p of s.timelinePath) {
          const pl = parseLatLngString(p.point);
          if (!pl) continue;
          const off = parseFloat(p.durationMinutesOffsetFromStartTime || 0) * 60 * 1000;
          points.push({ t: t0 + off, lat: pl.lat, lng: pl.lng });
        }
        if (points.length >= 2) {
          out.segments.push({
            t0, t1,
            type: 'UNKNOWN',
            distance: 0,
            confidence: 0.5,
            points,
            startLat: points[0].lat, startLng: points[0].lng,
            endLat: points[points.length - 1].lat, endLng: points[points.length - 1].lng,
            isFlight: false,
          });
        }
      }
    }
  }

  // ---------- format detection ----------

  function detectFormat(json) {
    if (!json || typeof json !== 'object') return null;
    // Consolidated: { legacy_records, timeline } — must come before the individual checks
    if (Array.isArray(json.legacy_records) || (Array.isArray(json.timeline) && json.sources)) return 'consolidated';
    if (Array.isArray(json.locations)) return 'records';
    if (Array.isArray(json.timelineObjects)) return 'semantic-legacy';
    if (Array.isArray(json.semanticSegments)) return 'timeline-new';
    // Raw array of iPhone timeline entries
    if (Array.isArray(json) && json.length && (json[0].startTime || json[0].visit || json[0].activity || json[0].timelinePath)) {
      return 'iphone-timeline-array';
    }
    return null;
  }

  // ---------- public entry points ----------

  // Parse one JSON object based on detected format.
  function parseOne(json, out) {
    const fmt = detectFormat(json);
    if (fmt === 'consolidated') { parseConsolidated(json, out); return fmt; }
    if (fmt === 'records') { parseRecords(json, out); return fmt; }
    if (fmt === 'semantic-legacy') { parseSemanticMonth(json, out); return fmt; }
    if (fmt === 'timeline-new') { parseTimelineNew(json, out); return fmt; }
    if (fmt === 'iphone-timeline-array') {
      for (const entry of json) parseIPhoneTimelineEntry(entry, out);
      return fmt;
    }
    return null;
  }

  // Accept a list of { name, text } file descriptors and merge everything.
  // Returns { visits, segments, rawPoints, formatsFound, fileCount }.
  function parseAll(files) {
    const out = { visits: [], segments: [], rawPoints: [] };
    const formatsFound = new Set();
    let fileCount = 0;
    for (const f of files) {
      let json;
      try { json = JSON.parse(f.text); }
      catch { continue; }
      const fmt = parseOne(json, out);
      if (fmt) { formatsFound.add(fmt); fileCount++; }
    }
    out.formatsFound = [...formatsFound];
    out.fileCount = fileCount;
    return out;
  }

  // ---------- zip ingestion ----------

  // Returns a promise of [{ name, text }] for every .json we care about inside a zip.
  async function readZip(zipBlob, progress) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');
    const zip = await JSZip.loadAsync(zipBlob);
    const relevant = [];
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      const lower = path.toLowerCase();
      if (!lower.endsWith('.json')) return;
      // Skip summary / settings files that would never contain location data
      if (lower.endsWith('settings.json')) return;
      if (lower.includes('/metadata/')) return;
      relevant.push(entry);
    });
    const results = [];
    let done = 0;
    for (const entry of relevant) {
      const text = await entry.async('string');
      results.push({ name: entry.name, text });
      done++;
      if (progress) progress(done, relevant.length, entry.name);
    }
    return results;
  }

  // ---------- file list ingestion (dropped files, file picker) ----------

  // Read a single file with byte-level progress via FileReader (ProgressEvent).
  // Returns a string.
  function readTextWithProgress(file, progress) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (progress && e.lengthComputable) {
          const mb = (e.loaded / 1048576).toFixed(1);
          const total = (e.total / 1048576).toFixed(0);
          progress(`Reading ${file.name}: ${mb} / ${total} MB`);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsText(file);
    });
  }

  async function readFileList(fileList, progress) {
    const out = [];
    const files = Array.from(fileList);
    let done = 0;
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        const contents = await readZip(file, (d, total, name) => {
          if (progress) progress(`Unzipping ${file.name}: ${d}/${total}`);
        });
        out.push(...contents);
      } else if (lower.endsWith('.json')) {
        const text = await readTextWithProgress(file, progress);
        out.push({ name: file.name, text });
      }
      done++;
      if (progress) progress(`Loaded ${done}/${files.length} input files`);
    }
    return out;
  }

  return {
    parseAll,
    readZip,
    readFileList,
    normalizeActivity,
    parseAddress,
  };
})();
