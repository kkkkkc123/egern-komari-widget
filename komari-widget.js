/**
 * Komari VPS Widget for Egern
 *
 * Required env:
 *   KOMARI_URL=https://komari.example.com
 *
 * Optional env:
 *   API_KEY=                     Komari API Key (Bearer), needed for private/hidden nodes
 *   NODE_FILTER=Tokyo,uuid...    Comma/semicolon separated names, UUIDs, or UUID prefixes
 *   TITLE=Komari
 *   REFRESH_MINUTES=10
 *   MAX_NODES=0                  0 = choose automatically for the widget size
 *   INSECURE_TLS=false           true only for a trusted self-signed certificate
 */

const C = {
  bg1: '#101827',
  bg2: '#172554',
  card: '#FFFFFF0D',
  cardBorder: '#FFFFFF12',
  text: '#F8FAFC',
  secondary: '#CBD5E1',
  muted: '#94A3B8',
  green: '#34D399',
  yellow: '#FBBF24',
  red: '#FB7185',
  blue: '#60A5FA',
  cyan: '#22D3EE',
  purple: '#C084FC',
};

const LOCK_TEXT = { light: '#111827', dark: '#F8FAFC' };
const LOCK_MUTED = { light: '#4B5563', dark: '#CBD5E1' };
const LONG_TERM_DAYS = 3650;

export default async function (ctx) {
  try {
    return await buildKomariWidget(ctx);
  } catch (error) {
    // Keep this fallback deliberately minimal. If a device/runtime rejects one
    // of the richer layout branches, Egern should show the actual error instead
    // of rendering a completely blank widget.
    return {
      type: 'widget',
      padding: 14,
      gap: 6,
      backgroundColor: '#2B1720',
      children: [
        {
          type: 'text',
          text: 'Komari 小组件运行失败',
          font: { size: 14, weight: 'bold' },
          textColor: '#FFFFFF',
        },
        {
          type: 'text',
          text: shortError(error),
          font: { size: 11, weight: 'medium' },
          textColor: '#FFB4C0',
          maxLines: 4,
          minScale: 0.7,
        },
      ],
    };
  }
}

async function buildKomariWidget(ctx) {
  const env = ctx.env || {};
  const family = ctx.widgetFamily || 'systemMedium';
  const baseUrl = normalizeBaseUrl(env.KOMARI_URL || env.URL || '');
  const refreshMinutes = clamp(toNumber(env.REFRESH_MINUTES, 10), 5, 60);
  const refreshAfter = new Date(Date.now() + refreshMinutes * 60 * 1000).toISOString();

  if (!baseUrl) {
    return errorWidget(family, '请设置 KOMARI_URL', refreshAfter);
  }

  const options = {
    baseUrl,
    apiKey: String(env.API_KEY || env.KOMARI_API_KEY || '').trim(),
    insecureTls: toBoolean(env.INSECURE_TLS),
    timeout: clamp(toNumber(env.TIMEOUT_MS, 12000), 3000, 30000),
  };

  const cacheKey = `komari-widget:${baseUrl}`;
  let payload;
  let stale = false;
  let fetchError = null;

  try {
    payload = await fetchKomari(ctx, options);
    payload.fetchedAt = new Date().toISOString();
    try {
      ctx.storage.setJSON(cacheKey, payload);
    } catch (_) {
      // The widget still works if storage is unavailable.
    }
  } catch (error) {
    fetchError = error;
    try {
      payload = ctx.storage.getJSON(cacheKey);
      stale = Boolean(payload && Array.isArray(payload.nodes));
    } catch (_) {
      payload = null;
    }
  }

  if (!payload || !Array.isArray(payload.nodes)) {
    return errorWidget(
      family,
      `Komari 连接失败\n${shortError(fetchError)}`,
      refreshAfter,
      baseUrl,
    );
  }

  let nodes = selectNodes(payload.nodes, env.NODE_FILTER || env.NODES || '');
  if (!nodes.length) {
    return errorWidget(family, 'NODE_FILTER 没有匹配到节点', refreshAfter, baseUrl);
  }

  const autoLimit = familyLimit(family);
  const configuredLimit = clamp(toNumber(env.MAX_NODES, 0), 0, 20);
  const limit = configuredLimit > 0 ? Math.min(configuredLimit, autoLimit) : autoLimit;
  const visibleNodes = nodes.slice(0, Math.max(1, limit));
  const meta = {
    title: String(env.TITLE || 'Komari').trim() || 'Komari',
    baseUrl,
    fetchedAt: payload.fetchedAt || new Date().toISOString(),
    refreshAfter,
    stale,
    total: nodes.length,
    online: nodes.filter((node) => node.online).length,
    totalDown: nodes.reduce((sum, node) => sum + numberOrZero(node.netDown), 0),
    totalUp: nodes.reduce((sum, node) => sum + numberOrZero(node.netUp), 0),
  };

  if (family === 'accessoryInline') return inlineWidget(meta);
  if (family === 'accessoryCircular') return circularWidget(meta);
  if (family === 'accessoryRectangular') return rectangularWidget(visibleNodes, meta);
  if (family === 'systemSmall') return smallWidget(visibleNodes[0], meta);
  if (family === 'systemExtraLarge') return extraLargeWidget(visibleNodes, meta);
  if (family === 'systemLarge') return largeWidget(visibleNodes, meta);
  return dashboardWidget(visibleNodes, meta);
}

async function fetchKomari(ctx, options) {
  try {
    return await fetchRpc2(ctx, options);
  } catch (rpcError) {
    try {
      return await fetchLegacyRest(ctx, options);
    } catch (restError) {
      throw new Error(`RPC2: ${shortError(rpcError)}; REST: ${shortError(restError)}`);
    }
  }
}

async function fetchRpc2(ctx, options) {
  const requiredRequests = [
    { jsonrpc: '2.0', id: 'nodes', method: 'common:getNodes', params: {} },
    { jsonrpc: '2.0', id: 'status', method: 'common:getNodesLatestStatus', params: {} },
  ];
  const pingRequest = {
    jsonrpc: '2.0',
    id: 'ping',
    method: 'common:getRecords',
    params: { type: 'ping', hours: 1, maxCount: 500 },
  };
  const requests = [...requiredRequests, pingRequest];
  let replies;

  // JSON-RPC batch is one network request. Some older RPC2 builds may not accept
  // batches, so retry as two parallel JSON-RPC requests when necessary.
  try {
    const response = await ctx.http.post(`${options.baseUrl}/api/rpc2`, {
      ...httpOptions(options),
      body: JSON.stringify(requests),
    });
    ensureHttpOk(response, 'RPC2 batch');
    const json = await response.json();
    if (!Array.isArray(json)) throw new Error('服务器不支持 JSON-RPC batch');
    replies = json;
  } catch (_) {
    replies = await Promise.all(requiredRequests.map((request) => rpcCall(ctx, options, request)));
    try {
      replies.push(await rpcCall(ctx, options, pingRequest));
    } catch (_) {
      // Ping data is optional and must never block the core server metrics.
    }
  }

  const nodesResult = rpcResult(replies, 'nodes');
  const statusResult = rpcResult(replies, 'status') || {};
  const pingStats = normalizePingStats(optionalRpcResult(replies, 'ping'));
  const rawNodes = Array.isArray(nodesResult)
    ? nodesResult
    : Object.keys(nodesResult || {}).map((key) => nodesResult[key]);

  if (!rawNodes.length) throw new Error('没有可见节点或认证失败');

  return {
    nodes: rawNodes.map((node) => normalizeNode(
      node,
      statusResult[node.uuid] || null,
      pingStats[node.uuid] || null,
    )),
  };
}

async function rpcCall(ctx, options, request) {
  const response = await ctx.http.post(`${options.baseUrl}/api/rpc2`, {
    ...httpOptions(options),
    body: JSON.stringify(request),
  });
  ensureHttpOk(response, request.method);
  return await response.json();
}

function rpcResult(replies, id) {
  const reply = replies.find((item) => String(item && item.id) === id);
  if (!reply) throw new Error(`RPC2 缺少 ${id} 响应`);
  if (reply.error) {
    const message = reply.error.message || JSON.stringify(reply.error);
    throw new Error(message);
  }
  return reply.result;
}

function optionalRpcResult(replies, id) {
  const reply = replies.find((item) => String(item && item.id) === id);
  return reply && !reply.error ? reply.result : null;
}

function normalizePingStats(result) {
  const output = {};
  if (!result || typeof result !== 'object') return output;

  const basicInfo = Array.isArray(result.basic_info) ? result.basic_info : [];
  for (const item of basicInfo) {
    const uuid = String(item && item.client || '');
    if (!uuid) continue;
    output[uuid] = {
      latency: firstNumber(item.avg, item.min),
      loss: clamp(numberOrZero(item.loss), 0, 100),
    };
  }

  const samples = {};
  const records = Array.isArray(result.records) ? result.records : [];
  for (const record of records) {
    const uuid = String(record && record.client || '');
    const latency = numberOrNull(record && record.value);
    if (!uuid || latency === null || latency < 0) continue;
    if (!samples[uuid]) samples[uuid] = [];
    samples[uuid].push(latency);
  }

  for (const uuid of Object.keys(samples)) {
    const values = samples[uuid];
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (!output[uuid]) output[uuid] = { latency: null, loss: null };
    output[uuid].latency = average;
  }

  return output;
}

async function fetchLegacyRest(ctx, options) {
  const nodeResponse = await ctx.http.get(`${options.baseUrl}/api/nodes`, httpOptions(options));
  ensureHttpOk(nodeResponse, 'GET /api/nodes');
  const nodeJson = await nodeResponse.json();
  const rawNodes = unwrapData(nodeJson);
  if (!Array.isArray(rawNodes) || !rawNodes.length) {
    throw new Error('没有可见节点或认证失败');
  }

  const nodes = await Promise.all(rawNodes.map(async (node) => {
    try {
      const response = await ctx.http.get(
        `${options.baseUrl}/api/recent/${encodeURIComponent(node.uuid)}`,
        httpOptions(options),
      );
      ensureHttpOk(response, `recent/${node.uuid}`);
      const json = await response.json();
      const records = unwrapData(json);
      const latest = latestRecord(Array.isArray(records) ? records : []);
      return normalizeNode(node, normalizeLegacyStatus(latest));
    } catch (_) {
      return normalizeNode(node, null);
    }
  }));

  return { nodes };
}

function httpOptions(options) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  return {
    headers,
    timeout: options.timeout,
    insecureTls: options.insecureTls,
    credentials: 'include',
  };
}

function ensureHttpOk(response, label) {
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error(`${label} HTTP ${response ? response.status : 'unknown'}`);
  }
}

function unwrapData(value) {
  if (value && value.status && value.status !== 'success') {
    throw new Error(value.message || 'Komari API 返回失败');
  }
  return value && Object.prototype.hasOwnProperty.call(value, 'data') ? value.data : value;
}

function latestRecord(records) {
  if (!records.length) return null;
  return records.reduce((latest, current) => {
    const a = new Date((latest && (latest.updated_at || latest.time)) || 0).getTime();
    const b = new Date((current && (current.updated_at || current.time)) || 0).getTime();
    return b >= a ? current : latest;
  }, records[0]);
}

function normalizeLegacyStatus(record) {
  if (!record) return null;
  const updatedAt = record.updated_at || record.time || null;
  const age = updatedAt ? Date.now() - new Date(updatedAt).getTime() : Infinity;
  return {
    time: updatedAt,
    online: Number.isFinite(age) && age < 3 * 60 * 1000,
    cpu: nestedNumber(record, ['cpu', 'usage']),
    ram: nestedNumber(record, ['ram', 'used']),
    ram_total: nestedNumber(record, ['ram', 'total']),
    swap: nestedNumber(record, ['swap', 'used']),
    swap_total: nestedNumber(record, ['swap', 'total']),
    load: nestedNumber(record, ['load', 'load1']),
    load5: nestedNumber(record, ['load', 'load5']),
    load15: nestedNumber(record, ['load', 'load15']),
    disk: nestedNumber(record, ['disk', 'used']),
    disk_total: nestedNumber(record, ['disk', 'total']),
    net_out: nestedNumber(record, ['network', 'up']),
    net_in: nestedNumber(record, ['network', 'down']),
    net_total_up: nestedNumber(record, ['network', 'totalUp']),
    net_total_down: nestedNumber(record, ['network', 'totalDown']),
    process: numberOrNull(record.process),
    connections: nestedNumber(record, ['connections', 'tcp']),
    connections_udp: nestedNumber(record, ['connections', 'udp']),
    uptime: numberOrNull(record.uptime),
  };
}

function normalizeNode(node, status, ping) {
  const state = status || {};
  const pingState = ping || {};
  const ramTotal = firstNumber(state.ram_total, node.mem_total);
  const diskTotal = firstNumber(state.disk_total, node.disk_total);
  const ramUsed = numberOrNull(state.ram);
  const diskUsed = numberOrNull(state.disk);
  const totalUp = numberOrZero(state.net_total_up);
  const totalDown = numberOrZero(state.net_total_down);
  return {
    uuid: String(node.uuid || ''),
    name: String(node.name || 'Unnamed'),
    region: String(node.region || ''),
    group: String(node.group || ''),
    weight: numberOrZero(node.weight),
    online: state.online === true,
    updatedAt: state.time || state.updated_at || null,
    cpu: clamp(numberOrZero(state.cpu), 0, 100),
    ramUsed,
    ramTotal,
    ramPercent: percent(ramUsed, ramTotal),
    diskUsed,
    diskTotal,
    diskPercent: percent(diskUsed, diskTotal),
    swapUsed: numberOrNull(state.swap),
    swapTotal: firstNumber(state.swap_total, node.swap_total),
    load: numberOrNull(state.load),
    netUp: numberOrZero(state.net_out),
    netDown: numberOrZero(state.net_in),
    totalUp,
    totalDown,
    uptime: numberOrNull(state.uptime),
    connections: numberOrNull(state.connections),
    process: numberOrNull(state.process),
    latency: numberOrNull(pingState.latency),
    loss: numberOrNull(pingState.loss),
    expiredAt: node.expired_at || null,
    autoRenewal: Boolean(node.auto_renewal),
    trafficLimit: numberOrZero(node.traffic_limit),
    trafficLimitType: String(node.traffic_limit_type || 'sum'),
    trafficUsed: trafficUsed(totalUp, totalDown, node.traffic_limit_type),
  };
}

function selectNodes(nodes, rawFilter) {
  const tokens = String(rawFilter || '')
    .split(/[,;\n]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length) {
    return nodes.slice().sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  }

  const selected = [];
  for (const token of tokens) {
    const node = nodes.find((item) => {
      const uuid = item.uuid.toLowerCase();
      const name = item.name.toLowerCase();
      return uuid === token || uuid.startsWith(token) || name === token;
    });
    if (node && !selected.some((item) => item.uuid === node.uuid)) selected.push(node);
  }
  return selected;
}

function smallWidget(node, meta) {
  const updatedAt = node.updatedAt || meta.fetchedAt;
  return baseWidget(meta, [
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 7,
      children: [
        symbol('server.rack', C.blue, 16),
        text(`${node.region ? `${node.region} ` : ''}${node.name}`, 14, C.text, 'bold', 1),
        { type: 'spacer' },
        statusDot(node.online, 9),
      ],
    },
    { type: 'spacer', length: 8 },
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 10,
      children: [
        {
          type: 'stack', direction: 'column', gap: 0,
          children: [
            text(`${Math.round(node.cpu)}%`, 30, metricColor(node.cpu), 'bold'),
            text('CPU', 10, C.muted, 'semibold'),
          ],
        },
        {
          type: 'stack', direction: 'column', gap: 5, flex: 1,
          children: [
            smallMetric('内存', node.ramPercent, C.cyan),
            smallMetric('硬盘', node.diskPercent, C.purple),
          ],
        },
      ],
    },
    { type: 'spacer' },
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
      children: [
        symbol('arrow.down', C.green, 10),
        text(formatSpeed(node.netDown), 10, C.secondary, 'medium'),
        { type: 'spacer', length: 5 },
        symbol('arrow.up', C.blue, 10),
        text(formatSpeed(node.netUp), 10, C.secondary, 'medium'),
        { type: 'spacer' },
        text(expiryLabel(node), 10, expiryColor(node), 'medium', 1),
      ],
    },
    {
      type: 'stack', direction: 'row', alignItems: 'center',
      children: [
        text(meta.stale ? '缓存数据' : node.online ? '在线' : '离线', 9, node.online ? C.green : C.red, 'semibold'),
        { type: 'spacer' },
        dateText(updatedAt, 9, C.muted),
      ],
    },
  ], 13, 5);
}

function dashboardWidget(nodes, meta) {
  const children = [dashboardHeader(meta)];
  for (const node of nodes) children.push(nodeRow(node, false));
  children.push({ type: 'spacer' });
  children.push(networkFooter(meta));
  return baseWidget(meta, children, 12, 6);
}

function largeWidget(nodes, meta) {
  return baseWidget(meta, [
    dashboardHeader(meta),
    largeOverview(nodes, meta),
    {
      type: 'stack',
      direction: 'column',
      alignItems: 'start',
      gap: 6,
      flex: 1,
      children: nodes.map((node) => largeNodeCard(node)),
    },
    largeFooter(meta),
  ], 12, 7);
}

function largeOverview(nodes, meta) {
  const averageLatency = averageNodeMetric(nodes, 'latency');
  const averageLoss = averageNodeMetric(nodes, 'loss');
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 6,
    children: [
      overviewCard(
        '在线节点',
        `${meta.online}/${meta.total}`,
        meta.online === meta.total ? '全部正常' : `${meta.total - meta.online} 台离线`,
        'checkmark.circle.fill',
        meta.online === meta.total ? C.green : C.yellow,
      ),
      overviewCard(
        '实时网络',
        `↓ ${formatSpeed(meta.totalDown)}`,
        `↑ ${formatSpeed(meta.totalUp)}`,
        'arrow.up.arrow.down.circle.fill',
        C.blue,
      ),
      overviewCard(
        '网络质量',
        `延迟 ${formatLatency(averageLatency)}`,
        `丢包 ${formatLoss(averageLoss)}`,
        'waveform.path.ecg',
        networkHealthColor({ latency: averageLatency, loss: averageLoss }),
      ),
    ],
  };
}

function overviewCard(label, value, detail, icon, color) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 1,
    flex: 1,
    padding: [5, 6],
    backgroundColor: '#FFFFFF0D',
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#FFFFFF14',
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
        children: [
          symbol(icon, color, 11),
          text(label, 9, C.muted, 'semibold', 1),
        ],
      },
      text(value, 12, C.text, 'bold', 1),
      text(detail, 9, color, 'medium', 1),
    ],
  };
}

function largeNodeCard(node) {
  const name = text(
    `${node.region ? `${node.region} ` : ''}${node.name}`,
    13,
    C.text,
    'bold',
    1,
  );
  name.flex = 1;
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 3,
    flex: 1,
    padding: [5, 8],
    backgroundGradient: {
      type: 'linear',
      colors: ['#FFFFFF10', node.online ? '#2563EB16' : '#BE123C16'],
      stops: [0, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    borderRadius: 10,
    borderWidth: 1,
    borderColor: node.online ? '#60A5FA32' : '#FB718532',
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
        children: [
          name,
          statusBadge(node.online),
          text(expiryLabel(node), 9, expiryColor(node), 'semibold', 1),
        ],
      },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 8,
        children: [
          metricGauge('CPU', node.cpu, metricColor(node.cpu)),
          metricGauge('内存', node.ramPercent, metricColor(node.ramPercent)),
          metricGauge('硬盘', node.diskPercent, metricColor(node.diskPercent)),
        ],
      },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
        children: [
          symbol('arrow.down', C.green, 9),
          text(formatSpeed(node.netDown), 9, C.secondary, 'medium'),
          symbol('arrow.up', C.blue, 9),
          text(formatSpeed(node.netUp), 9, C.secondary, 'medium'),
          { type: 'spacer' },
          text(
            `延迟 ${formatLatency(node.latency)} · 丢包 ${formatLoss(node.loss)}`,
            9,
            networkHealthColor(node),
            'semibold',
            1,
          ),
        ],
      },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
        children: [
          symbol('chart.pie.fill', C.cyan, 10),
          text(trafficLabel(node), 9, C.secondary, 'medium', 1),
          { type: 'spacer' },
          trafficGauge(node),
        ],
      },
    ],
  };
}

function metricGauge(label, value, color) {
  return {
    type: 'stack',
    direction: 'column',
    alignItems: 'start',
    gap: 2,
    flex: 1,
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center',
        children: [
          text(label, 9, C.muted, 'semibold'),
          { type: 'spacer' },
          text(displayPercent(value), 10, color, 'bold'),
        ],
      },
      segmentedGauge(value, color, 10),
    ],
  };
}

function trafficGauge(node) {
  if (node.trafficLimit <= 0) return text('不限流量', 9, C.muted, 'medium');
  const usage = percent(node.trafficUsed, node.trafficLimit);
  const gauge = segmentedGauge(usage, metricColor(usage), 8);
  gauge.width = 68;
  return gauge;
}

function segmentedGauge(value, color, segments) {
  const active = Number.isFinite(value)
    ? clamp(Math.ceil(value / (100 / segments)), 0, segments)
    : 0;
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 2,
    height: 4,
    children: Array.from({ length: segments }, (_, index) => ({
      type: 'stack',
      flex: 1,
      height: 4,
      backgroundColor: index < active ? color : '#FFFFFF14',
      borderRadius: 2,
      children: [],
    })),
  };
}

function statusBadge(online) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 3,
    padding: [1, 5],
    backgroundColor: online ? '#34D39920' : '#FB718520',
    borderRadius: 7,
    children: [
      statusDot(online, 6),
      text(online ? '在线' : '离线', 9, online ? C.green : C.red, 'semibold'),
    ],
  };
}

function extraLargeWidget(nodes, meta) {
  const midpoint = Math.ceil(nodes.length / 2);
  const left = nodes.slice(0, midpoint);
  const right = nodes.slice(midpoint);
  const columns = [columnOfRows(left)];
  if (right.length) columns.push(columnOfRows(right));
  return baseWidget(meta, [
    dashboardHeader(meta),
    {
      type: 'stack', direction: 'row', alignItems: 'start', gap: 10, flex: 1,
      children: columns,
    },
    networkFooter(meta),
  ], 16, 8);
}

function columnOfRows(nodes) {
  return {
    type: 'stack', direction: 'column', alignItems: 'start', gap: 7, flex: 1,
    children: nodes.map((node) => nodeRow(node, true)),
  };
}

function dashboardHeader(meta) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 7,
    children: [
      symbol('server.rack', C.blue, 17),
      text(meta.title, 15, C.text, 'bold', 1),
      { type: 'spacer' },
      statusDot(meta.online === meta.total, 8),
      text(`${meta.online}/${meta.total}`, 11, C.secondary, 'semibold'),
      text(meta.stale ? '缓存' : '已更新', 10, meta.stale ? C.yellow : C.muted, 'medium'),
    ],
  };
}

function nodeRow(node, detailed) {
  const nodeName = text(
    `${node.region ? `${node.region} ` : ''}${node.name}`,
    detailed ? 13 : 11,
    C.text,
    'semibold',
    1,
  );
  nodeName.flex = 1;
  const top = {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
    children: [
      statusDot(node.online, 8),
      nodeName,
      metricText('CPU', node.cpu, metricColor(node.cpu), detailed ? 10 : 9),
      metricText('内存', node.ramPercent, metricColor(node.ramPercent), detailed ? 10 : 9),
      metricText('硬盘', node.diskPercent, metricColor(node.diskPercent), detailed ? 10 : 9),
    ],
  };
  const children = [top];
  if (detailed) {
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [
        text(node.online ? `↓ ${formatSpeed(node.netDown)}  ↑ ${formatSpeed(node.netUp)}` : '暂无实时数据', 10, C.muted, 'medium', 1),
        { type: 'spacer' },
        text(
          `延迟 ${formatLatency(node.latency)} · 丢包 ${formatLoss(node.loss)}`,
          10,
          networkHealthColor(node),
          'medium',
          1,
        ),
      ],
    });
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [
        text(trafficLabel(node), 10, C.secondary, 'medium', 1),
        { type: 'spacer' },
        text(expiryLabel(node), 10, expiryColor(node), 'medium', 1),
      ],
    });
  }
  const row = {
    type: 'stack', direction: 'column', alignItems: 'start', gap: 3,
    padding: detailed ? [6, 8] : [7, 8],
    backgroundColor: C.card,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: C.cardBorder,
    children,
  };
  if (detailed) row.flex = 1;
  return row;
}

function networkFooter(meta) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      symbol('arrow.down.circle.fill', C.green, 12),
      text(formatSpeed(meta.totalDown), 10, C.secondary, 'medium'),
      symbol('arrow.up.circle.fill', C.blue, 12),
      text(formatSpeed(meta.totalUp), 10, C.secondary, 'medium'),
      { type: 'spacer' },
      dateText(meta.fetchedAt, 10, C.muted),
    ],
  };
}

function largeFooter(meta) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      symbol('clock.arrow.circlepath', meta.stale ? C.yellow : C.cyan, 11),
      text(meta.stale ? '正在显示缓存数据' : '数据更新于', 9, meta.stale ? C.yellow : C.muted, 'medium'),
      dateText(meta.fetchedAt, 9, C.secondary),
      { type: 'spacer' },
      symbol('arrow.up.right.square', C.blue, 10),
      text('打开 Komari', 9, C.secondary, 'semibold'),
    ],
  };
}

function inlineWidget(meta) {
  return {
    type: 'widget',
    url: meta.baseUrl,
    refreshAfter: meta.refreshAfter,
    children: [text(`● ${meta.title}  ${meta.online}/${meta.total} 在线`, 12, LOCK_TEXT, 'semibold', 1)],
  };
}

function circularWidget(meta) {
  return {
    type: 'widget',
    url: meta.baseUrl,
    refreshAfter: meta.refreshAfter,
    padding: 3,
    children: [
      { type: 'spacer' },
      text(`${meta.online}/${meta.total}`, 17, LOCK_TEXT, 'bold', 1, 'center'),
      text('在线', 9, LOCK_MUTED, 'semibold', 1, 'center'),
      { type: 'spacer' },
    ],
  };
}

function rectangularWidget(nodes, meta) {
  const children = [{
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      text(meta.title, 11, LOCK_TEXT, 'bold', 1),
      { type: 'spacer' },
      text(`${meta.online}/${meta.total}`, 10, LOCK_MUTED, 'semibold'),
    ],
  }];
  for (const node of nodes.slice(0, 2)) {
    children.push({
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [
        statusDot(node.online, 6),
        text(`${node.region ? `${node.region} ` : ''}${node.name}`, 10, LOCK_TEXT, 'semibold', 1),
        text(
          `CPU ${Math.round(node.cpu)}% · 内存 ${displayPercent(node.ramPercent)} · 硬盘 ${displayPercent(node.diskPercent)}`,
          8,
          LOCK_MUTED,
          'medium',
          1,
        ),
      ],
    });
  }
  return {
    type: 'widget',
    url: meta.baseUrl,
    refreshAfter: meta.refreshAfter,
    gap: 2,
    children,
  };
}

function baseWidget(meta, children, padding, gap) {
  return {
    type: 'widget',
    url: meta.baseUrl,
    refreshAfter: meta.refreshAfter,
    padding,
    gap,
    backgroundGradient: {
      type: 'linear',
      colors: [C.bg1, C.bg2],
      stops: [0, 1],
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 1, y: 1 },
    },
    children,
  };
}

function errorWidget(family, message, refreshAfter, url) {
  const lock = family && family.startsWith('accessory');
  const widget = {
    type: 'widget',
    refreshAfter,
    padding: lock ? 2 : 14,
    gap: 6,
    children: [
      symbol('exclamationmark.triangle.fill', C.yellow, lock ? 13 : 18),
      text(message, lock ? 10 : 12, lock ? LOCK_TEXT : C.text, 'semibold', 3),
    ],
  };
  if (url) widget.url = url;
  if (!lock) {
    widget.backgroundGradient = {
      type: 'linear', colors: [C.bg1, '#3F1D2E'],
      startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 },
    };
  }
  return widget;
}

function smallMetric(label, value, color) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center',
    children: [
      text(label, 10, C.muted, 'semibold'),
      { type: 'spacer' },
      text(displayPercent(value), 12, color, 'bold'),
    ],
  };
}

function metricText(label, value, color, size) {
  return text(`${label} ${displayPercent(value)}`, size || 10, color, 'semibold');
}

function symbol(name, color, size) {
  return { type: 'image', src: `sf-symbol:${name}`, color, width: size, height: size };
}

function statusDot(online, size) {
  return symbol('circle.fill', online ? C.green : C.red, size);
}

function text(value, size, color, weight, maxLines, align) {
  const element = {
    type: 'text',
    text: String(value),
    font: { size, weight: weight || 'regular' },
    textColor: color,
    minScale: 0.65,
  };
  if (maxLines) element.maxLines = maxLines;
  if (align) element.textAlign = align;
  return element;
}

function dateText(date, size, color) {
  return {
    type: 'date',
    date: date || new Date().toISOString(),
    format: 'relative',
    font: { size, weight: 'medium' },
    textColor: color,
    maxLines: 1,
    minScale: 0.7,
  };
}

function familyLimit(family) {
  if (family === 'systemSmall') return 1;
  if (family === 'systemLarge') return 3;
  if (family === 'systemExtraLarge') return 10;
  if (family === 'accessoryRectangular') return 2;
  if (family === 'accessoryInline' || family === 'accessoryCircular') return 1;
  return 3;
}

function metricColor(value) {
  if (value === null || value === undefined) return C.muted;
  if (value >= 90) return C.red;
  if (value >= 70) return C.yellow;
  return C.green;
}

function displayPercent(value) {
  return value === null || value === undefined ? '--' : `${Math.round(value)}%`;
}

function percent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return clamp((used / total) * 100, 0, 100);
}

function formatSpeed(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B/s`;
  if (bytes < 1024 ** 2) return `${trimNumber(bytes / 1024)} K/s`;
  if (bytes < 1024 ** 3) return `${trimNumber(bytes / 1024 ** 2)} M/s`;
  return `${trimNumber(bytes / 1024 ** 3)} G/s`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${trimNumber(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${trimNumber(bytes / 1024 ** 2)} MB`;
  if (bytes < 1024 ** 4) return `${trimNumber(bytes / 1024 ** 3)} GB`;
  return `${trimNumber(bytes / 1024 ** 4)} TB`;
}

function trafficLabel(node) {
  const used = numberOrZero(node.trafficUsed);
  if (node.trafficLimit > 0) {
    const usage = percent(used, node.trafficLimit);
    return `流量 ${formatBytes(used)} / ${formatBytes(node.trafficLimit)} (${displayPercent(usage)})`;
  }
  return `流量 ${formatBytes(used)}`;
}

function formatLatency(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : '--';
}

function formatLoss(value) {
  return Number.isFinite(value) ? `${trimNumber(value)}%` : '--';
}

function networkHealthColor(node) {
  if (!Number.isFinite(node.latency) && !Number.isFinite(node.loss)) return C.muted;
  if (node.loss >= 10 || node.latency >= 300) return C.red;
  if (node.loss >= 3 || node.latency >= 180) return C.yellow;
  return C.green;
}

function averageNodeMetric(nodes, key) {
  const values = nodes
    .map((node) => numberOrNull(node[key]))
    .filter((value) => value !== null);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function trimNumber(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

function expiryLabel(node) {
  if (!node.expiredAt) return node.autoRenewal ? '自动续费' : '未设到期';
  const timestamp = new Date(node.expiredAt).getTime();
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1)) return '未设到期';
  const days = Math.ceil((timestamp - Date.now()) / 86400000);
  if (!Number.isFinite(days)) return '到期未知';
  if (days > LONG_TERM_DAYS) return '长期有效';
  if (days < 0) return `已到期 ${Math.abs(days)}天`;
  if (days === 0) return '今天到期';
  return `${days}天到期`;
}

function expiryColor(node) {
  if (!node.expiredAt) return C.muted;
  const days = (new Date(node.expiredAt).getTime() - Date.now()) / 86400000;
  if (!Number.isFinite(days)) return C.muted;
  if (days > LONG_TERM_DAYS) return C.green;
  if (days < 7) return C.red;
  if (days < 30) return C.yellow;
  return C.muted;
}

function trafficUsed(up, down, type) {
  if (type === 'up') return up;
  if (type === 'down') return down;
  if (type === 'max') return Math.max(up, down);
  if (type === 'min') return Math.min(up, down);
  return up + down;
}

function nestedNumber(object, path) {
  let value = object;
  for (const key of path) value = value && value[key];
  return numberOrNull(value);
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = numberOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  const number = numberOrNull(value);
  return number === null ? 0 : number;
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function shortError(error) {
  const message = error && error.message ? error.message : String(error || '未知错误');
  return message.length > 110 ? `${message.slice(0, 107)}...` : message;
}
