// Minimal GTFS Realtime protobuf decoder. Zero dependencies.
// Decodes only the fields Rideline uses, including the newer
// TripDescriptor.modified_trip (field 7) that older bindings drop.
'use strict';

class Reader {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }
  // Unsigned varint as Number. Long (>7 byte) encodings go through BigInt so
  // negative int32/int64 values (10-byte two's complement) stay exact.
  varint(signed = false) {
    const start = this.p;
    let byte, n = 0;
    do { byte = this.b[this.p++]; n++; } while (byte & 0x80 && n < 10);
    if (n <= 7) {
      let result = 0, mul = 1;
      for (let i = start; i < this.p; i++) { result += (this.b[i] & 0x7f) * mul; mul *= 128; }
      return result;
    }
    let big = 0n, shift = 0n;
    for (let i = start; i < this.p; i++) { big |= BigInt(this.b[i] & 0x7f) << shift; shift += 7n; }
    return Number(signed ? BigInt.asIntN(64, big) : BigInt.asUintN(64, big));
  }
  fixed32() { const v = this.b.readFloatLE(this.p); this.p += 4; return v; }
  fixed64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  bytes() { const len = this.varint(); const s = this.p; this.p += len; return [s, this.p]; }
  str() { const [s, e] = this.bytes(); return this.b.toString('utf8', s, e); }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.p += 8;
    else if (wt === 2) { const len = this.varint(); this.p += len; }
    else if (wt === 5) this.p += 4;
    else throw new Error('unsupported wire type ' + wt);
  }
  // iterate fields: cb(fieldNumber, wireType) must consume or return false to skip
  each(cb) {
    while (this.p < this.end) {
      const key = this.varint();
      const fn = Math.floor(key / 8), wt = key & 7;
      const pos = this.p;
      if (cb(fn, wt) === false) { this.p = pos; this.skip(wt); }
    }
  }
  sub(fn) { const [s, e] = this.bytes(); return fn(new Reader(this.b, s, e)); }
}



function translatedString(r) {
  const out = [];
  r.each((fn) => {
    if (fn !== 1) return false;
    out.push(r.sub(t => { const o = {}; t.each(f => { if (f === 1) o.text = t.str(); else if (f === 2) o.lang = t.str(); else return false; }); return o; }));
  });
  const en = out.find(t => !t.lang || /^en/i.test(t.lang));
  return (en || out[0] || {}).text || '';
}

function tripDescriptor(r) {
  const t = {};
  r.each((fn) => {
    switch (fn) {
      case 1: t.tripId = r.str(); break;
      case 2: t.startTime = r.str(); break;
      case 3: t.startDate = r.str(); break;
      case 4: t.scheduleRelationship = r.varint(); break;
      case 5: t.routeId = r.str(); break;
      case 6: t.directionId = r.varint(); break;
      case 7: t.modified = r.sub(m => { const o = {}; m.each(f => {
        if (f === 1) o.modificationsId = m.str();
        else if (f === 2) o.affectedTripId = m.str();
        else if (f === 3) o.startTime = m.str();
        else if (f === 4) o.startDate = m.str();
        else return false; }); return o; }); break;
      default: return false;
    }
  });
  return t;
}

function vehicleDescriptor(r) {
  const v = {};
  r.each((fn) => { if (fn === 1) v.id = r.str(); else if (fn === 2) v.label = r.str(); else return false; });
  return v;
}

function stopTimeEvent(r) {
  const e = {};
  r.each((fn) => {
    if (fn === 1) e.delay = r.varint(true);
    else if (fn === 2) e.time = r.varint(true);
    else if (fn === 4) e.scheduledTime = r.varint(true);
    else return false;
  });
  return e;
}

function tripUpdate(r) {
  const u = { stops: [] };
  r.each((fn) => {
    switch (fn) {
      case 1: u.trip = r.sub(tripDescriptor); break;
      case 2: u.stops.push(r.sub(s => { const o = {}; s.each(f => {
        if (f === 1) o.seq = s.varint();
        else if (f === 2) o.arrival = s.sub(stopTimeEvent);
        else if (f === 3) o.departure = s.sub(stopTimeEvent);
        else if (f === 4) o.stopId = s.str();
        else if (f === 5) o.rel = s.varint();
        else return false; }); return o; })); break;
      case 3: u.vehicle = r.sub(vehicleDescriptor); break;
      case 4: u.timestamp = r.varint(); break;
      case 5: u.delay = r.varint(true); break;
      default: return false;
    }
  });
  return u;
}

function vehiclePosition(r) {
  const v = {};
  r.each((fn) => {
    switch (fn) {
      case 1: v.trip = r.sub(tripDescriptor); break;
      case 2: v.position = r.sub(p => { const o = {}; p.each((f, wt) => {
        if (f === 1 && wt === 5) o.lat = p.fixed32();
        else if (f === 2 && wt === 5) o.lon = p.fixed32();
        else if (f === 3 && wt === 5) o.bearing = p.fixed32();
        else if (f === 4 && wt === 1) o.odometer = p.fixed64();
        else if (f === 5 && wt === 5) o.speed = p.fixed32();
        else return false; }); return o; }); break;
      case 3: v.currentStopSequence = r.varint(); break;
      case 4: v.currentStatus = r.varint(); break;
      case 5: v.timestamp = r.varint(); break;
      case 7: v.stopId = r.str(); break;
      case 8: v.vehicle = r.sub(vehicleDescriptor); break;
      case 9: v.occupancy = r.varint(); break;
      default: return false;
    }
  });
  return v;
}

function alert(r) {
  const a = { periods: [], entities: [] };
  r.each((fn) => {
    switch (fn) {
      case 1: a.periods.push(r.sub(t => { const o = {}; t.each(f => { if (f === 1) o.start = t.varint(); else if (f === 2) o.end = t.varint(); else return false; }); return o; })); break;
      case 5: a.entities.push(r.sub(e => { const o = {}; e.each(f => {
        if (f === 1) o.agencyId = e.str();
        else if (f === 2) o.routeId = e.str();
        else if (f === 4) o.trip = e.sub(tripDescriptor);
        else if (f === 5) o.stopId = e.str();
        else return false; }); return o; })); break;
      case 6: a.cause = r.varint(); break;
      case 7: a.effect = r.varint(); break;
      case 8: a.url = r.sub(translatedString); break;
      case 10: a.header = r.sub(translatedString); break;
      case 11: a.description = r.sub(translatedString); break;
      default: return false;
    }
  });
  return a;
}

function decodeFeed(buf) {
  const r = new Reader(buf);
  const feed = { header: {}, entities: [] };
  r.each((fn) => {
    if (fn === 1) {
      feed.header = r.sub(h => { const o = {}; h.each(f => {
        if (f === 1) o.version = h.str(); else if (f === 2) o.incrementality = h.varint();
        else if (f === 3) o.timestamp = h.varint(); else return false; }); return o; });
    } else if (fn === 2) {
      feed.entities.push(r.sub(e => { const o = {}; e.each(f => {
        if (f === 1) o.id = e.str();
        else if (f === 2) o.deleted = !!e.varint();
        else if (f === 3) o.tripUpdate = e.sub(tripUpdate);
        else if (f === 4) o.vehicle = e.sub(vehiclePosition);
        else if (f === 5) o.alert = e.sub(alert);
        else return false; }); return o; }));
    } else return false;
  });
  return feed;
}

module.exports = { decodeFeed };
