#!/usr/bin/env node
// Chạy bởi GitHub Actions (.github/workflows/update.yml) mỗi giờ.
// Đọc channels.json -> gọi YouTube Data API v3 -> ghi data/index.json + data/<channelId>.json
// API key lấy từ biến môi trường YOUTUBE_API_KEY (đặt trong GitHub Secrets, KHÔNG commit key vào repo).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Thiếu YOUTUBE_API_KEY (đặt trong Settings → Secrets and variables → Actions).');
  process.exit(1);
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAX_HISTORY = 200; // ~8 ngày nếu chạy mỗi giờ — đủ để tính VPH theo nhiều khung giờ khác nhau

// ---------- Danh sách thị trường ----------
// Mỗi thị trường có 1 file channels riêng và ghi data vào 1 thư mục riêng
// dưới data/, để trang web load tách biệt theo thị trường.
// Muốn thêm thị trường mới: thêm 1 dòng vào đây + tạo file channels-xx.json tương ứng.
const MARKETS = [
  { key: 'en', label: 'Tiếng Anh', channelsFile: path.join(ROOT, 'channels-en.json') },
  { key: 'es', label: 'Tây Ban Nha', channelsFile: path.join(ROOT, 'channels-es.json') },
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

async function apiGet(pathName, params) {
  const url = new URL(API_BASE + pathName);
  params.key = API_KEY;
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `Lỗi API (${res.status})`);
  }
  return data;
}

// ---------- giống logic parse input trong webapp ----------
function parseChannelInput(raw) {
  const s = String(raw).trim();
  let m;
  if ((m = s.match(/youtube\.com\/channel\/(UC[\w-]{10,})/i))) return { type: 'id', value: m[1] };
  if ((m = s.match(/youtube\.com\/@([\w.\-]+)/i))) return { type: 'handle', value: '@' + m[1] };
  if ((m = s.match(/youtube\.com\/c\/([\w.\-]+)/i))) return { type: 'username', value: m[1] };
  if ((m = s.match(/youtube\.com\/user\/([\w.\-]+)/i))) return { type: 'username', value: m[1] };
  if (/^UC[\w-]{10,}$/.test(s)) return { type: 'id', value: s };
  if (s.startsWith('@')) return { type: 'handle', value: s };
  return { type: 'guess', value: s };
}

async function resolveChannel(parsed) {
  let data;
  if (parsed.type === 'id') {
    data = await apiGet('/channels', { part: 'snippet,contentDetails,statistics', id: parsed.value });
  } else if (parsed.type === 'handle') {
    data = await apiGet('/channels', { part: 'snippet,contentDetails,statistics', forHandle: parsed.value });
  } else if (parsed.type === 'username') {
    data = await apiGet('/channels', { part: 'snippet,contentDetails,statistics', forUsername: parsed.value });
  }
  if (!data || !data.items || !data.items.length) {
    try {
      data = await apiGet('/channels', { part: 'snippet,contentDetails,statistics', forHandle: '@' + parsed.value.replace(/^@/, '') });
    } catch (e) { /* ignore, fall through to search */ }
  }
  if (!data || !data.items || !data.items.length) {
    const search = await apiGet('/search', { part: 'snippet', type: 'channel', q: parsed.value, maxResults: 1 });
    if (!search.items || !search.items.length) throw new Error('Không tìm thấy kênh: ' + parsed.value);
    const chId = search.items[0].snippet.channelId || search.items[0].id.channelId;
    data = await apiGet('/channels', { part: 'snippet,contentDetails,statistics', id: chId });
  }
  if (!data.items || !data.items.length) throw new Error('Không tìm thấy kênh: ' + parsed.value);
  const item = data.items[0];
  return {
    channelId: item.id,
    title: item.snippet.title,
    thumbnail: item.snippet.thumbnails?.default?.url || '',
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    videoCount: Number(item.statistics?.videoCount || 0),
  };
}

async function fetchAllPlaylistVideos(uploadsPlaylistId) {
  let items = [];
  let pageToken = '';
  let pages = 0;
  while (pages < 250) {
    const data = await apiGet('/playlistItems', {
      part: 'snippet', playlistId: uploadsPlaylistId, maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    (data.items || []).forEach((it) => {
      const sn = it.snippet;
      if (!sn || !sn.resourceId || !sn.resourceId.videoId) return;
      items.push({
        id: sn.resourceId.videoId,
        title: sn.title,
        description: sn.description || '',
        thumb: sn.thumbnails?.medium?.url || sn.thumbnails?.default?.url || '',
        publishedAt: sn.publishedAt,
      });
    });
    pages++;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return items;
}

async function attachViewCounts(items) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 50) chunks.push(items.slice(i, i + 50));
  const byId = {};
  for (const chunk of chunks) {
    const ids = chunk.map((v) => v.id).join(',');
    const data = await apiGet('/videos', { part: 'statistics', id: ids });
    (data.items || []).forEach((it) => { byId[it.id] = Number(it.statistics?.viewCount || 0); });
  }
  items.forEach((v) => { v.views = byId[v.id] ?? 0; });
  return items;
}

async function updateMarket(market) {
  const rawList = readJson(market.channelsFile, []);
  if (!Array.isArray(rawList) || !rawList.length) {
    console.log(`[${market.key}] channels file trống — không có kênh nào để cập nhật.`);
    return;
  }
  const dataDir = path.join(ROOT, 'data', market.key);
  fs.mkdirSync(dataDir, { recursive: true });

  const newChannels = [];
  for (const raw of rawList) {
    try {
      const parsed = parseChannelInput(raw);
      const meta = await resolveChannel(parsed);
      console.log(`[${market.key}] Đang cập nhật: ${meta.title} (${meta.channelId})`);

      const dataFile = path.join(dataDir, `${meta.channelId}.json`);
      const oldVideos = readJson(dataFile, []);
      const oldById = {};
      oldVideos.forEach((v) => { oldById[v.id] = v; });

      const items = await fetchAllPlaylistVideos(meta.uploadsPlaylistId);
      await attachViewCounts(items);

      const now = Date.now();
      items.forEach((v) => {
        v.channelId = meta.channelId;
        v.channelTitle = meta.title;
        const old = oldById[v.id];
        const history = old && old.history ? old.history.slice() : [];
        history.push({ t: now, v: v.views });
        if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
        v.history = history;
      });

      fs.writeFileSync(dataFile, JSON.stringify(items));
      newChannels.push({ ...meta, lastUpdated: new Date(now).toISOString() });
    } catch (e) {
      console.error(`[${market.key}] Lỗi với "${raw}": ${e.message}`);
    }
  }

  fs.writeFileSync(
    path.join(dataDir, 'index.json'),
    JSON.stringify({ market: market.key, label: market.label, updatedAt: new Date().toISOString(), channels: newChannels }, null, 2)
  );
  console.log(`[${market.key}] Hoàn tất — ${newChannels.length} kênh.`);
}

async function main() {
  for (const market of MARKETS) {
    await updateMarket(market);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
