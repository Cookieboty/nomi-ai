#!/bin/bash
# canvas-rig contact strip: run-strip.sh ACTION "t0,t1,..." OUTDIR
ENV=$(python3 - "$1" "$2" <<'P'
import json,sys
print(json.dumps({'model':'/nomi-2d-polish/packages/renderer/public/assets/models/sprite/nomi','actions':[sys.argv[1]],'times':[float(x) for x in sys.argv[2].split(',')],'cols':6,'frames':6,'scale':0.3,'crop':[0,0,960,1120],'tail':0.3}))
P
)
ENV="$ENV" node "$(dirname "$0")/shot.mjs" "$(dirname "$0")/strip.js" "$3"
