#!/usr/bin/env node
// Chạy bởi GitHub Actions (.github/workflows/update.yml) mỗi giờ.
// Đọc channels.json -> gọi YouTube Data API v3 -> ghi data/index.json + data/<channelId>.json
// Sau đó đẩy toàn bộ data lên Google Sheets (2 tab: Tiếng Anh + Tây Ban Nha).
// Secrets cần có trong GitHub: YOUTUBE_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SHEET_ID

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Thiếu YOUTUBE_API_KEY (đặt trong Settings → Secrets and variables → Actions).');
  process.exit(1);
}

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAX_HISTORY = 200;

const MARKETS = [
  { key: 'en', label: 'Tiếng Anh', channelsFile: path.join(ROOT, 'channels-en.json') },
  { key: 'es', label: 'Tây Ban Nha', channelsFile: path.join(ROOT, 'channels-es.json') },
];

// ─────────────────────────────────────────────
// Helpers chung
// ─────────────────────────────────────────────
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
  if (!res.ok) throw new Error(data?.error?.message || `Lỗi API (${res.status})`);
  return data;
}

// ─────────────────────────────────────────────
// YouTube helpers
// ─────────────────────────────────────────────
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
    } catch (e) { /* ignore */ }
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
    subscriberCount: item.statistics?.hiddenSubscriberCount ? null : Number(item.statistics?.subscriberCount || 0),
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
    (data.items || []).forEach((it) => {
      byId[it.id] = {
        views: Number(it.statistics?.viewCount || 0),
        likes: it.statistics?.likeCount != null ? Number(it.statistics.likeCount) : null,
      };
    });
  }
  items.forEach((v) => {
    const s = byId[v.id] || {};
    v.views = s.views ?? 0;
    v.likes = s.likes ?? null;
  });
  return items;
}

// Tính VPH từ history (giống webapp)
function calcVph(video) {
  const hist = video.history || [];
  if (hist.length >= 2) {
    const last = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    const hours = (last.t - prev.t) / 3_600_000;
    if (hours > 0) return (last.v - prev.v) / hours;
  }
  // Fallback: trung bình suốt đời
  const hoursSincePublish = (Date.now() - new Date(video.publishedAt).getTime()) / 3_600_000;
  return hoursSincePublish > 0 ? video.views / hoursSincePublish : 0;
}

// ─────────────────────────────────────────────
// Google Sheets helpers (không cần npm package)
// ─────────────────────────────────────────────

// Tạo JWT cho service account Google
function createJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(serviceAccount.private_key, 'base64url');
  return `${header}.${payload}.${sig}`;
}

// Lấy access token từ JWT
async function getAccessToken(serviceAccount) {
  const jwt = createJwt(serviceAccount);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Lấy access token thất bại: ' + JSON.stringify(data));
  return data.access_token;
}

// Lấy danh sách sheet ID theo title
async function getSheetIds(spreadsheetId, token) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Lấy info spreadsheet thất bại: ' + JSON.stringify(data));
  const map = {};
  (data.sheets || []).forEach(s => { map[s.properties.title] = s.properties.sheetId; });
  return map;
}

// Tạo tab mới hoặc xoá hết nội dung tab cũ
async function ensureAndClearSheet(spreadsheetId, sheetTitle, token) {
  const existing = await getSheetIds(spreadsheetId, token);
  const requests = [];

  if (existing[sheetTitle] == null) {
    // Tạo tab mới
    requests.push({ addSheet: { properties: { title: sheetTitle } } });
  } else {
    // Xoá hết nội dung tab cũ
    requests.push({
      updateCells: {
        range: { sheetId: existing[sheetTitle] },
        fields: 'userEnteredValue',
      },
    });
  }

  if (requests.length) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error('batchUpdate thất bại: ' + JSON.stringify(data));
  }
}

// Ghi dữ liệu vào tab (valueInputOption: RAW để không hiểu nhầm số/ngày)
async function writeSheetData(spreadsheetId, sheetTitle, rows, token) {
  const range = encodeURIComponent(`${sheetTitle}!A1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Ghi Sheets "${sheetTitle}" thất bại: ` + JSON.stringify(data));
  console.log(`[Sheets] Tab "${sheetTitle}": đã ghi ${rows.length - 1} dòng.`);
}

// Chuyển toàn bộ videos của 1 thị trường thành mảng rows cho Sheets
function buildSheetRows(marketKey, updatedAt) {
  const dataDir = path.join(ROOT, 'data', marketKey);
  const index = readJson(path.join(dataDir, 'index.json'), { channels: [] });

  // Map subscriberCount theo channelId
  const subsByChannel = {};
  (index.channels || []).forEach(ch => { subsByChannel[ch.channelId] = ch.subscriberCount; });

  const HEADERS = [
    'Tiêu đề video', 'Kênh', 'Subscribers', 'Lượt xem', 'VPH', 'Lượt like',
    'Ngày đăng', 'Link video', 'Ngày cập nhật',
  ];

  const rows = [HEADERS];

  for (const ch of (index.channels || [])) {
    const videos = readJson(path.join(dataDir, `${ch.channelId}.json`), []);
    for (const v of videos) {
      const vph = calcVph(v);
      rows.push([
        v.title || '',
        v.channelTitle || ch.title || '',
        subsByChannel[v.channelId] != null ? subsByChannel[v.channelId] : 'ẩn',
        v.views || 0,
        Math.round(vph * 10) / 10,
        v.likes != null ? v.likes : 'ẩn',
        v.publishedAt ? v.publishedAt.slice(0, 10) : '',
        `https://www.youtube.com/watch?v=${v.id}`,
        updatedAt,
      ]);
    }
  }

  return rows;
}

async function pushToGoogleSheets() {
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!saJson || !sheetId) {
    console.log('[Sheets] Thiếu GOOGLE_SERVICE_ACCOUNT_JSON hoặc GOOGLE_SHEET_ID — bỏ qua bước đẩy Sheets.');
    return;
  }

  let serviceAccount;
  try { serviceAccount = JSON.parse(saJson); }
  catch (e) { console.error('[Sheets] GOOGLE_SERVICE_ACCOUNT_JSON không hợp lệ:', e.message); return; }

  const token = await getAccessToken(serviceAccount);
  const updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  for (const market of MARKETS) {
    const tabName = market.label; // "Tiếng Anh" / "Tây Ban Nha"
    console.log(`[Sheets] Đang chuẩn bị tab "${tabName}"...`);
    await ensureAndClearSheet(sheetId, tabName, token);
    const rows = buildSheetRows(market.key, updatedAt);
    await writeSheetData(sheetId, tabName, rows, token);
  }

  console.log('[Sheets] Đẩy dữ liệu lên Google Sheets hoàn tất.');
}

// ─────────────────────────────────────────────
// Core update logic
// ─────────────────────────────────────────────
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
  // Bước 1: Cập nhật data từ YouTube API
  for (const market of MARKETS) {
    await updateMarket(market);
  }
  // Bước 2: Đẩy toàn bộ data lên Google Sheets
  await pushToGoogleSheets();
}

main().catch((e) => { console.error(e); process.exit(1); });
