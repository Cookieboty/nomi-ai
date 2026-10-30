"""把 measure-* 的输出汇总成 markdown：每场景三次求和后取中位数，并列出中位那次的各进程。"""
import csv, glob, os, re, statistics, sys
out = sys.argv[1]; lines = []
for f in sorted(glob.glob(os.path.join(out, '*-1.tsv')) + glob.glob(os.path.join(out, '*-1.csv'))):
    base = f[:-6]; ext = f[-4:]; mode_label = os.path.basename(base)
    runs = []
    for i in (1, 2, 3):
        p = f'{base}-{i}{ext}'
        if not os.path.exists(p): continue
        rows = list(csv.DictReader(open(p, encoding='utf-8-sig'), delimiter='\t' if ext == '.tsv' else ','))
        runs.append(rows)
    if ext == '.tsv':
        cols = [('footprint_mb', lambda r: float(re.sub('[^0-9.]', '', r['footprint_mb'])) * (1/1024 if r['footprint_mb'].endswith('K') else 1024 if r['footprint_mb'].endswith('G') else 1) if r['footprint_mb'] != 'NA' else None),
                ('rss_MiB', lambda r: int(r['rss_kb']) / 1024)]
    else:
        cols = [('privWS_MiB', lambda r: float(r['privWS_MiB'])), ('private_MiB', lambda r: float(r['private_MiB'])), ('ws_MiB', lambda r: float(r['ws_MiB']))]
    tot = {}
    for name, fn in cols:
        sums = []
        for rows in runs:
            v = [fn(r) for r in rows]; sums.append(None if any(x is None for x in v) else sum(v))
        ok = [s for s in sums if s is not None]
        tot[name] = f'{statistics.median(ok):.1f}' if ok else 'NA'
    detail = '; '.join(f"{r.get('name')}{'/'+r['type'] if r.get('type') else ''}=" + '/'.join(str(r.get(c[0].replace('rss_MiB','rss_kb'))) for c in cols) for r in runs[len(runs)//2]) if runs else ''
    lines.append(f"| {mode_label} | n={len(runs[0]) if runs else 0} | " + ' | '.join(f'{k}={v}' for k, v in tot.items()) + f' | {detail} |')
print('\n'.join(lines))
