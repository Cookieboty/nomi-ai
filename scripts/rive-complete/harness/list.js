/* eslint-disable -- evaluation harness (box-specific paths), not shipped */
const out = {};
for (const A of H.ACTIONS) {
  const ps = [...new Set(A.tracks.map((t) => t.p))];
  out[A.id] = {
    dur: A.dur,
    both: ps.includes('rA') && ps.includes('lA'),
    ps: ps.filter((p) => /^[rl][AE]$/.test(p)).join(','),
  };
}
return {
  acts: Object.entries(out)
    .filter(([k, v]) => v.both)
    .map(([k, v]) => k + ':' + v.dur)
    .join(' '),
};
