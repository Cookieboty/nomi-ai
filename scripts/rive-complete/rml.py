"""Tiny RML (Rive markup) emitter used by build-nomi-rive.py.

Only structure + id bookkeeping lives here; no artwork is generated. Every pixel of the
character comes from the brand-locked layer PNGs referenced via <ImageAsset file=...>.
"""
from __future__ import annotations
from xml.sax.saxutils import quoteattr


class El:
    _next = 10

    def __init__(self, tag: str, name: str | None = None, ident: bool = False, **attrs):
        self.tag = tag
        self.attrs: dict = {}
        if name is not None:
            self.attrs['name'] = name
        for k, v in attrs.items():
            self.attrs[k] = v
        self.children: list[El] = []
        self.id: str | None = None
        if ident:
            self.need_id()

    def need_id(self) -> str:
        if self.id is None:
            self.id = f'0:{El._next}'
            El._next += 1
            self.attrs['id'] = self.id
        return self.id

    def add(self, *kids: 'El') -> 'El':
        self.children.extend(kids)
        return self

    def emit(self, depth: int = 0) -> str:
        pad = '    ' * depth
        a = ''.join(f' {k}={quoteattr(fmt(v))}' for k, v in self.attrs.items())
        if not self.children:
            return f'{pad}<{self.tag}{a}/>\n'
        out = f'{pad}<{self.tag}{a}>\n'
        for c in self.children:
            out += c.emit(depth + 1)
        return out + f'{pad}</{self.tag}>\n'


def fmt(v) -> str:
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, float):
        s = f'{v:.5f}'.rstrip('0').rstrip('.')
        return s if s not in ('-0', '') else '0'
    return str(v)
