const DATACENTER_ASNS = new Set([
  16509, 14618, 38895,      // AWS
  15169, 396982, 19527,     // Google Cloud
  8075, 3598, 6182,         // Microsoft Azure
  14061, 135173,            // DigitalOcean
  24940, 213230,            // Hetzner
  16276,                    // OVH
  13335,                    // Cloudflare
  54113,                    // Fastly
  20940,                    // Akamai
  19281, 6939,              // Hurricane Electric
  32934,                    // Meta
  63949,                    // Linode/Akamai
  55967,                    // Rackspace
  36351,                    // SoftLayer/IBM Cloud
]);

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function incrementTotal(env) {
  const current = parseInt((await env.INFRA_KV.get('meta:total')) ?? '0', 10);
  await env.INFRA_KV.put('meta:total', String(current + 1));
}

async function notifyDiscord(webhookUrl, hit) {
  const embed = {
    title: `🍯 Hit: \`${hit.src}\``,
    color: hit.isDatacenter ? 0xe74c3c : 0xf39c12,
    fields: [
      { name: 'Vector',   value: `\`${hit.src}\``,                                          inline: true },
      { name: 'IP',       value: hit.ip,                                                     inline: true },
      { name: 'Type',     value: hit.isDatacenter ? '🤖 Datacenter' : '🏠 Residential',    inline: true },
      { name: 'ASN',      value: hit.asn ? `AS${hit.asn} ${hit.asnOrg ?? ''}` : 'unknown',  inline: true },
      { name: 'Location', value: [hit.city, hit.country].filter(Boolean).join(', ') || '?', inline: true },
      { name: 'Colo',     value: hit.colo ?? '?',                                            inline: true },
      { name: 'User-Agent', value: hit.ua ? `\`${hit.ua.slice(0, 120)}\`` : 'none',         inline: false },
      ...(hit.referer ? [{ name: 'Referer', value: hit.referer.slice(0, 120), inline: false }] : []),
    ],
    footer: { text: `id: ${hit.id}` },
    timestamp: hit.ts,
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch {
    // Discord notification is best-effort
  }
}

async function logHit(request, env, ctx, url) {
  const cf = request.cf ?? {};

  const hit = {
    id: crypto.randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
    asn: cf.asn ?? null,
    asnOrg: cf.asOrganization ?? null,
    country: cf.country ?? null,
    city: cf.city ?? null,
    colo: cf.colo ?? null,
    isDatacenter: DATACENTER_ASNS.has(cf.asn),
    threatScore: cf.threatScore ?? null,
    ua: request.headers.get('User-Agent') ?? '',
    referer: request.headers.get('Referer') ?? '',
    src: url.searchParams.get('src') ?? url.pathname.replace(/^\//, '') ?? 'unknown',
    path: url.pathname,
    method: request.method,
    // Capture headers agents might reveal (strip CF internals)
    headers: Object.fromEntries(
      [...request.headers.entries()].filter(([k]) =>
        !k.startsWith('cf-') && !k.startsWith('x-forwarded') && k !== 'x-real-ip'
      )
    ),
  };

  const key = `hit:${hit.ts}:${hit.id}`;

  ctx.waitUntil(
    Promise.all([
      env.INFRA_KV.put(key, JSON.stringify(hit), { expirationTtl: 60 * 60 * 24 * 90 }),
      incrementTotal(env),
      env.DISCORD_WEBHOOK_URL ? notifyDiscord(env.DISCORD_WEBHOOK_URL, hit) : Promise.resolve(),
    ])
  );

  return new Response('OK\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

async function handleDashboard(request, env) {
  const url = new URL(request.url);

  if (!env.DASHBOARD_SECRET || url.searchParams.get('secret') !== env.DASHBOARD_SECRET) {
    return new Response('401 Unauthorized\n', { status: 401 });
  }

  const [listResult, totalRaw] = await Promise.all([
    env.INFRA_KV.list({ prefix: 'hit:', limit: 1000 }),
    env.INFRA_KV.get('meta:total'),
  ]);

  // Newest first, cap at 200 to limit KV reads
  const recentKeys = [...listResult.keys].reverse().slice(0, 200);

  const hits = (await Promise.all(recentKeys.map(({ name }) => env.INFRA_KV.get(name))))
    .map(v => (v ? JSON.parse(v) : null))
    .filter(Boolean);

  const byVector = {};
  const uniqueIPs = new Set();
  let datacenterHits = 0;

  for (const h of hits) {
    byVector[h.src] = (byVector[h.src] ?? 0) + 1;
    uniqueIPs.add(h.ip);
    if (h.isDatacenter) datacenterHits++;
  }

  return new Response(
    renderDashboard(hits, {
      total: totalRaw ?? '0',
      shown: hits.length,
      uniqueIPs: uniqueIPs.size,
      datacenterHits,
      byVector,
    }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

function renderDashboard(hits, stats) {
  const hitRows = hits
    .map(
      h => `
      <tr class="${h.isDatacenter ? 'dc' : ''}">
        <td class="mono">${esc(h.ts.replace('T', ' ').slice(0, 19))}</td>
        <td><strong>${esc(h.src)}</strong></td>
        <td class="mono">${esc(h.ip)}</td>
        <td class="dim">AS${esc(String(h.asn ?? '?'))} <small>${esc(h.asnOrg ?? '')}</small></td>
        <td class="dim">${esc([h.city, h.country].filter(Boolean).join(', ') || '?')}</td>
        <td>${h.isDatacenter ? '🤖' : '🏠'}</td>
        <td class="dim mono small">${esc((h.ua ?? '').slice(0, 90))}</td>
      </tr>`
    )
    .join('');

  const vectorRows = Object.entries(stats.byVector)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><strong>${v}</strong></td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Infra Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px;font-size:14px}
h1{color:#58a6ff;margin-bottom:24px;font-size:1.5rem}
h2{color:#8b949e;font-size:.85rem;margin:28px 0 10px;text-transform:uppercase;letter-spacing:.08em}
.stats{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:32px}
.stat{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px 24px;min-width:130px}
.stat .n{font-size:2rem;font-weight:700;color:#f0883e;line-height:1}
.stat .l{font-size:.75rem;color:#6e7681;margin-top:6px}
table{width:100%;border-collapse:collapse}
th{background:#161b22;color:#6e7681;text-align:left;padding:8px 12px;border-bottom:2px solid #30363d;font-weight:500;white-space:nowrap}
td{padding:6px 12px;border-bottom:1px solid #21262d;vertical-align:middle}
tr:hover td{background:#161b22}
tr.dc td{border-left:3px solid #e74c3c}
.mono{font-family:monospace}.dim{color:#8b949e}.small{font-size:.8em}
.vectors table{max-width:360px}
</style>
</head>
<body>
<h1>🍯 Infra Dashboard</h1>
<div class="stats">
  <div class="stat"><div class="n">${esc(stats.total)}</div><div class="l">All-time hits</div></div>
  <div class="stat"><div class="n">${stats.shown}</div><div class="l">Showing</div></div>
  <div class="stat"><div class="n">${stats.uniqueIPs}</div><div class="l">Unique IPs</div></div>
  <div class="stat"><div class="n">${stats.datacenterHits}</div><div class="l">Datacenter 🤖</div></div>
</div>

<h2>Hits by Vector</h2>
<div class="vectors">
<table>
  <thead><tr><th>Vector</th><th>Count</th></tr></thead>
  <tbody>${vectorRows}</tbody>
</table>
</div>

<h2>Recent Hits — newest first</h2>
<table>
  <thead>
    <tr>
      <th>Time (UTC)</th><th>Vector</th><th>IP</th><th>ASN</th>
      <th>Location</th><th>Type</th><th>User-Agent</th>
    </tr>
  </thead>
  <tbody>${hitRows}</tbody>
</table>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/dashboard') {
      return handleDashboard(request, env);
    }

    if (url.pathname === '/health') {
      return new Response('ok\n');
    }

    return logHit(request, env, ctx, url);
  },
};
