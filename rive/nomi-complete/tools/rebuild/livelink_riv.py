"""Receive one build from `rive . --headless-serve` (live-link on ws://127.0.0.1:<port>/) and write the
.riv it carries. Frames are 'RVLK' + u16 version + u16 type + u32 + u32 header (16 bytes); type 4 carries
the total size, type 5 carries consecutive chunks of the .riv, type 6 ends the build.
usage: livelink_riv.py <out.riv> [port]"""
import asyncio, struct, sys
import websockets


async def grab(port):
    total, chunks = None, []
    async with websockets.connect(f'ws://127.0.0.1:{port}/', max_size=None) as ws:
        while True:
            m = await asyncio.wait_for(ws.recv(), timeout=60)
            if m[:4] != b'RVLK':
                continue
            kind = struct.unpack('<H', m[6:8])[0]
            if kind == 4:
                total, chunks = struct.unpack('<I', m[16:20])[0], []
            elif kind == 5 and total is not None:
                chunks.append(m[16:])
            elif kind == 6 and total is not None:
                return total, b''.join(chunks)


total, riv = asyncio.run(grab(int(sys.argv[2]) if len(sys.argv) > 2 else 9640))
assert riv[:4] == b'RIVE' and len(riv) == total, (len(riv), total)
open(sys.argv[1], 'wb').write(riv)
print(f'wrote {sys.argv[1]} ({len(riv)} bytes)')
