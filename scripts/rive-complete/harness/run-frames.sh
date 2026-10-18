#!/bin/bash
# canvas-rig frames at exact frame indices: run-frames.sh ACTION "f1,f2,..." OUTDIR   (needs PW_CORE for playwright-core)
ENV=$(python3 - "$1" "$2" <<'P'
import json,sys
print(json.dumps({'model':'/nomi-2d-polish/packages/renderer/public/assets/models/sprite/nomi','action':sys.argv[1],'frames':[int(x) for x in sys.argv[2].split(',')],'scale':1}))
P
)
ENV="$ENV" node "$(dirname "$0")/shot.mjs" "$(dirname "$0")/frames-at.js" "$3"
