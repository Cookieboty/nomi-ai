// Parity cases for packages/gateway/src/privacy (batch 4d): rules, entropy, mergeSpans,
// placeholders, shapeOf, SecretStore, maskBody/maskText and the streaming Restorer.
export async function recordPrivacy({ gw }) {
  const P = await gw('src/privacy/index.ts');
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const word = (al, n) => { let s = ''; for (let i = 0; i < n; i++) s += al[Math.floor(rnd() * al.length)]; return s; };
  const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const HEX = '0123456789abcdef';
  const secret = () => pick([
    () => 'sk-' + pick(['', 'ant-', 'proj-', 'or-', 'admin-']) + word(B62 + '_-', 18 + Math.floor(rnd() * 30)),
    () => pick(['oc', 'or', 'abcd', 'a']) + '_sk_' + word(B62, 22),
    () => pick(['sk', 'rk']) + '_' + pick(['live', 'test']) + '_' + word(B62, 24),
    () => pick(['ghp_', 'gho_', 'github_pat_', 'glpat-']) + word(B62, 36),
    () => 'AIza' + word(B62 + '_-', 35 + Math.floor(rnd() * 2)),
    () => pick(['AKIA', 'ASIA']) + word(UP, 16 + Math.floor(rnd() * 2)),
    () => 'xox' + pick('abprz') + '-' + word(B62 + '-', 12),
    () => pick(['hf_' + word(B62, 32), 'xai-' + word(B62, 22), 'gsk_' + word(B62, 20)]),
    () => 'nomi-' + pick(['gw', 'tab']) + '-' + word(B62, 8),
    () => 'eyJ' + word(B62, 12) + '.eyJ' + word(B62, 14) + '.' + word(B62 + '_-', 20),
    () => pick(['Bearer ', 'bearer\t', 'BEARER  ']) + word(B62 + '._~+/=-', 12 + Math.floor(rnd() * 20)),
    () => pick(['postgres', 'https', 'redis']) + '://' + pick(['user', '', 'a.b']) + ':' + word(B62 + '!$', 3 + Math.floor(rnd() * 15)) + '@host/db',
    () => 'https://x.io/p' + pick(['?', '&', '?a=1&']) + pick(['key', 'api_key', 'Token', 'client_secret']) + '=' + word(B62, 8 + Math.floor(rnd() * 10)),
    () => pick(['API_KEY', 'password', 'db_secret', 'user_id', 'page_token', 'TOKEN', 'pwd']) + pick(['=', ': ', '="', "':'", ' = ']) + pick([word(B62 + '!@#', 4 + Math.floor(rnd() * 30)), 'changeme', 'xxxxxxxxxxxx', '${VAR}', '<your-key>', 'true', '1234567890abcdef']),
    () => '-----BEGIN ' + pick(['', 'RSA ', 'EC ', 'OPENSSH ']) + 'PRIVATE KEY-----\n' + word(B62 + '+/', 30) + '\n-----END ' + pick(['RSA ', '']) + 'PRIVATE KEY-----',
    () => word(HEX, 32 + Math.floor(rnd() * 8)),
    () => word(HEX, 8) + '-' + word(HEX, 4) + '-' + word(HEX, 4) + '-' + word(HEX, 4) + '-' + word(HEX, 12),
    () => '{{API_KEY_' + word('abcdefghijklmnopqrstuvwxyz234567', 8) + '}}',
  ])();
  const filler = ['', ' ', '\n', 'hello ', '中文 ', '"', "'", '{', '}', ',', ';', '(', 'x', '_', '\u00a0', '\u3000', '😀', '\ud800', 'ſ', 'K', 'key ', ':', '=', '\t', 'é'];
  const mixed = () => { let s = ''; for (let i = 0, n = 1 + Math.floor(rnd() * 6); i < n; i++) s += rnd() < 0.45 ? secret() : word(filler, Math.floor(rnd() * 6)); return s; };

  const texts = [''];
  for (let i = 0; i < 700; i++) texts.push(mixed());
  const rules = texts.map((s) => [s, JSON.stringify(P.ruleSpans(s)), JSON.stringify(P.ruleSpans(s, { strict: true })), P.entropy(s), P.hasSecret(s)]);

  const kinds = ['API_KEY', 'TOKEN', 'PRIVATE_KEY', 'PASSWORD', 'CUSTOM'];
  const merge = [];
  for (let i = 0; i < 200; i++) {
    const sp = [];
    for (let j = 0, n = Math.floor(rnd() * 7); j < n; j++) {
      const a = Math.floor(rnd() * 40);
      sp.push({ start: a, end: a + Math.floor(rnd() * 15), kind: pick(kinds), by: pick(['known', 'rule', 'strict']) });
    }
    merge.push([sp, JSON.stringify(P.mergeSpans(sp))]);
  }

  const ph = [];
  for (let i = 0; i < 300; i++) {
    const key = pick(['', 'k', 'secret-key-中', word(B62, 32)]);
    const kind = pick(kinds);
    const v = rnd() < 0.8 ? secret() : word(filler, 5);
    const tag = P.tagOf(key, kind, v);
    const n = pick([1, 2, 17]);
    ph.push([key, kind, v, tag, P.placeholderOf(kind, tag, n), n, P.allowTagOf(key, v), P.shapeOf(key, kind, v)]);
  }

  // SecretStore scripts
  const store = [];
  for (let sc = 0; sc < 12; sc++) {
    const max = sc === 11 ? undefined : pick([undefined, 3, 10, 50]);
    const st = new P.SecretStore(max === undefined ? {} : { maxValues: max });
    const ops = [];
    const seen = [];
    for (let i = 0, n = sc === 11 ? 500 : 80; i < n; i++) {
      const r = sc === 11 && i < 300 ? 0.3 : rnd();
      let op;
      if (r < 0.06) { const k = pick(['', 'a', 'k2']); st.setKey(k); op = ['setKey', k]; }
      else if (r < 0.1) { const on = rnd() < 0.5; st.setShape(on); op = ['setShape', on]; }
      else if (r < 0.14) { const l = []; for (let j = 0, n = Math.floor(rnd() * 5); j < n; j++) l.push({ kind: pick(kinds), value: pick([secret(), 'short', '', ...seen]) }); st.setKnown(l); op = ['setKnown', l]; }
      else if (r < 0.16) { st.clear(); op = ['clear']; }
      else if (r < 0.5) { const v = rnd() < 0.3 && seen.length ? pick(seen) : secret(); seen.push(v); op = ['assign', pick(kinds), v]; op.push(st.assign(op[1], v)); }
      else if (r < 0.6) { const p = pick([...ops.filter((o) => o[0] === 'assign').map((o) => o[3]), '{{X_aaaaaaaa}}']); op = ['valueOf', p, st.valueOf(p) ?? null]; }
      else { const s = word(filler, 3) + (seen.length ? pick(seen) : '') + word(filler, 2) + (seen.length && rnd() < 0.5 ? pick(seen) : '') + mixed(); op = ['find', s, JSON.stringify(st.find(s))]; }
      ops.push([...op, st.size]);
    }
    store.push({ max: max ?? null, ops });
  }

  // maskBody / maskText + Restorer
  const textBlock = () => mixed();
  const bodyOf = () => pick([
    () => ({ model: 'm', messages: [{ role: 'user', content: textBlock() }, { role: 'assistant', content: [{ type: 'text', text: textBlock() }, { type: 'tool_use', id: 'toolu_' + word(B62, 20), name: 'bash', input: { command: textBlock(), env: { API_KEY: secret() } } }] }] }),
    () => ({ model: 'm', system: textBlock(), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: textBlock() }, { type: 'image', source: { type: 'base64', data: word(B62, 40) } }] }] }),
    () => ({ input: [{ type: 'function_call', call_id: 'c' + word(B62, 30), arguments: JSON.stringify({ cmd: textBlock(), token: secret() }) }, { role: 'user', content: [{ type: 'input_text', text: textBlock() }] }], instructions: textBlock(), previous_response_id: 'resp_' + word(HEX, 32) }),
    () => ({ contents: [{ role: 'user', parts: [{ text: textBlock() }, { thoughtSignature: word(B62, 40) }] }], tools: [{ functionDeclarations: [{ name: 'f', description: textBlock(), parameters: { type: 'object', properties: { password: { type: 'string', default: secret() } } } }] }] }),
    () => ({ messages: [{ role: 'user', content: textBlock(), name: secret() }], metadata: { user_id: word(HEX, 32), api_key: secret() }, ['__proto__']: textBlock(), 'x-key': [secret(), 1, null, true] }),
  ])();
  const sseOf = (restore) => {
    const ps = [...restore.keys()];
    const piece = () => (ps.length && rnd() < 0.5 ? pick(ps) : '') + word(filler, Math.floor(rnd() * 4));
    let full = pick(['', ': keepalive\n\n', 'event: ping\ndata: {"type":"ping"}\n\n']);
    for (let i = 0, n = 2 + Math.floor(rnd() * 5); i < n; i++) {
      const t = pick(['content_block_delta', 'response.output_text.delta', 'response.function_call_arguments.delta', 'chat']);
      let j;
      if (t === 'content_block_delta') j = { type: t, index: Math.floor(rnd() * 2), delta: pick([{ type: 'text_delta', text: piece() }, { type: 'input_json_delta', partial_json: JSON.stringify(piece()).slice(1, -1) }]) };
      else if (t === 'chat') j = { id: 'x', choices: [{ index: 0, delta: { content: piece(), tool_calls: rnd() < 0.3 ? [{ index: 0, function: { arguments: piece() } }] : undefined } }] };
      else j = { type: t, item_id: 'it', output_index: 0, delta: piece() };
      full += (t === 'chat' ? '' : `event: ${t}\n`) + 'data: ' + JSON.stringify(j) + pick(['\n\n', '\r\n\r\n']);
      if (rnd() < 0.15) full += 'data: not json ' + piece() + '\n\n';
    }
    if (rnd() < 0.3) full += 'data: [DONE]\n\n';
    if (rnd() < 0.2) full += 'trailing ' + piece();
    // split at random code-unit boundaries
    const chunks = [];
    for (let i = 0; i < full.length;) { const n = 1 + Math.floor(rnd() * 25); chunks.push(full.slice(i, i + n)); i += n; }
    return chunks;
  };
  const mask = [];
  for (let sc = 0; sc < 6; sc++) {
    const st = new P.SecretStore();
    const key = pick(['k1', 'k2']);
    const shape = sc % 3 === 2;
    st.setKey(key); st.setShape(shape);
    const known = [{ kind: 'API_KEY', value: secret() }, { kind: 'TOKEN', value: 'nomi-gw-' + word(B62, 10) }];
    st.setKnown(known);
    const ops = [];
    for (let i = 0; i < 40; i++) {
      const opts = { key };
      if (rnd() < 0.3) opts.strict = true;
      if (rnd() < 0.3) opts.actions = { [pick(kinds)]: pick(['warn', 'block']), [pick(kinds)]: 'warn' };
      const allowFrom = rnd() < 0.2 ? secret() : null;
      const withText = rnd() < 0.3;
      const input = withText ? mixed() + (rnd() < 0.5 ? known[0].value : '') : bodyOf();
      const inJSON = JSON.stringify(input);
      const allow = allowFrom ? [P.allowTagOf(key, allowFrom)] : null;
      const o = { ...opts, ...(allow ? { allow: new Set(allow) } : {}) };
      const r = withText ? P.maskText(input, st, o) : P.maskBody(JSON.parse(inJSON), st, o);
      const rec = { opts, allow, text: withText, input: inJSON, out: withText ? r.text : JSON.stringify(r.body), hits: JSON.stringify(r.hits), restore: [...r.restore.entries()], blocked: r.blocked };
      const rs = new P.Restorer(r.restore);
      const chunks = sseOf(r.restore);
      rec.chunks = chunks;
      rec.pushed = chunks.map((c) => rs.push(c));
      rec.end = rs.end();
      const outText = withText ? r.text : JSON.stringify(r.body);
      rec.rawBack = rs.raw(outText);
      rec.jsonBack = JSON.stringify(rs.json(withText ? r.text : r.body));
      rec.escaped = rnd() < 0.5;
      rec.textBack = rs.text(outText, rec.escaped);
      rec.counts = [...rs.counts.entries()];
      ops.push(rec);
    }
    mask.push({ key, shape, known, ops });
  }

  const preview = [];
  for (let i = 0; i < 60; i++) {
    const p = { key: pick(['', 'pk']), strict: rnd() < 0.5, shape: rnd() < 0.3, actions: rnd() < 0.3 ? { TOKEN: 'block' } : undefined, allow: rnd() < 0.2 ? ['nope'] : [], known: rnd() < 0.5 ? [{ kind: 'CUSTOM', value: 'my-own-secret-123' }] : undefined };
    const t = mixed() + (rnd() < 0.5 ? ' my-own-secret-123 ' : '');
    const r = P.previewPrivacy(t, p);
    preview.push([t, JSON.parse(JSON.stringify(p)), r.text, JSON.stringify(r.hits)]);
  }
  return { rules, merge, ph, store, mask, preview, version: P.RULES_VERSION };
}
