/** 极简 semver 比较：major.minor.patch + 可选预发布段（1.0.0-rc.2 < 1.0.0） */
export function parseSemver(raw: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function prerelease(raw: string): string[] | null {
  const m = /\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/.exec(raw);
  return m ? m[1]!.split('.') : null;
}

function comparePre(a: string[] | null, b: string[] | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return comparePre(prerelease(latest), prerelease(current)) > 0;
}
