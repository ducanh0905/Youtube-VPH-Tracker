// scripts/fetch-data.mjs
//
// Pulls stats for one or more named lists of YouTube channels (videos +
// stats + comments) and writes static JSON files into public/data/ so the
// frontend (hosted as a static site on Netlify) never needs to touch the
// YouTube API or an API key directly.
//
// channels.json holds named lists ("markets"/tabs in the frontend), e.g.:
//   { "TBN": ["@kenh1", "..."], "4K": ["@kenh2", "..."] }
// Each list name produces its own output files:
//   public/data/videos-<LIST>.json
//   public/data/meta-<LIST>.json
// Comments are shared across lists in public/data/comments/<videoId>.json
// since a comment file only depends on the video, not which list found it.
//
// Each video record also gets:
//   viewsPerHour        - view velocity (see computeViewsPerHour() below for the
//                          "recent vs lifetime" logic)
//   viewsPerHourSource   - "recent" (real delta since last fetch) or "lifetime"
//                          (fallback average, used only the first time a video is seen)
//
// Run locally:   YOUTUBE_API_KEY=xxx node scripts/fetch-data.mjs
// Run in CI:      see .github/workflows/fetch-data.yml
//
// Config via env vars (all optional):
//   MAX_VIDEOS_PER_CHANNEL   default 50   - how many most-recent videos to track per channel
//   FULL_CHANNEL_HISTORY     default false - when true, ignores MAX_VIDEOS_PER_CHANNEL and
//                            pulls every video in each channel's uploads playlist (full
//                            back-catalog, not just the most recent ones). Uses more quota -
//                            meant for an occasional manual "fetch toàn bộ" run, not every
//                            scheduled run.
//   MAX_COMMENTS_PER_VIDEO   default 100  - how many top-level comments to store per video
//   MAX_REPLIES_PER_COMMENT  default 20   - how many replies to store per top-level comment
//   COMMENT_ORDER            default "relevance" (or "time") - ignored when
//                            COMMENT_MAX_AGE_DAYS > 0, which forces "time" order
//   COMMENT_MAX_AGE_DAYS     default 90   - only keep comments newer than this many
//                            days (0 = no limit, keep all up to MAX_COMMENTS_PER_VIDEO).
//                            Also stops paginating as soon as older comments are hit,
//                            so this actually saves quota, not just storage.
//   FORCE_REFRESH_COMMENTS   default false - refetch comments even if commentCount unchanged
//   YOUTUBE_API_KEY          a single API key
//   YOUTUBE_API_KEYS         multiple API keys, comma-separated - used as automatic
//                            fallbacks: when one key hits its daily quota
//                            (quotaExceeded), the script switches to the next key
//                            and keeps going instead of failing the whole run.

import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import path from "path";

const API_KEYS = (process.env.YOUTUBE_API_KEYS || process.env.YOUTUBE_API_KEY || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);
if (API_KEYS.length === 0) {
  console.error("Missing YOUTUBE_API_KEY or YOUTUBE_API_KEYS environment variable.");
  process.exit(1);
}
let apiKeyIndex = 0;
let keysExhausted = false; // true once every key has hit quotaExceeded

// Log this clearly at startup - the #1 cause of "key 2 never gets used" bug
// reports is that the workflow only passes YOUTUBE_API_KEY (singular) as an
// env var, so this array only ever has 1 entry no matter how many secrets
// exist in GitHub. Check this line in the Action logs first when debugging.
console.log(
  `Loaded ${API_KEYS.length} API key(s): ${API_KEYS.map((k) => k.slice(0, 4) + "…" + k.slice(-4)).join(", ")}`
);
if (API_KEYS.length < 2) {
  console.log(
    `  (Chỉ có 1 key - nếu bạn nghĩ mình đã cấu hình nhiều key, kiểm tra workflow đang set biến ` +
      `YOUTUBE_API_KEYS (số nhiều, cách nhau dấu phẩy) chứ không phải YOUTUBE_API_KEY.)`
  );
}

const MAX_VIDEOS_PER_CHANNEL = parseInt(process.env.MAX_VIDEOS_PER_CHANNEL || "50", 10);
const FULL_CHANNEL_HISTORY = /^true$/i.test(process.env.FULL_CHANNEL_HISTORY || "");
if (FULL_CHANNEL_HISTORY) {
  console.log("FULL_CHANNEL_HISTORY=true - sẽ lấy TOÀN BỘ video của mỗi kênh (bỏ qua giới hạn MAX_VIDEOS_PER_CHANNEL).");
}
const MAX_COMMENTS_PER_VIDEO = parseInt(process.env.MAX_COMMENTS_PER_VIDEO || "100", 10);
const MAX_REPLIES_PER_COMMENT = parseInt(process.env.MAX_REPLIES_PER_COMMENT || "20", 10);
const COMMENT_ORDER = process.env.COMMENT_ORDER || "relevance";
const COMMENT_MAX_AGE_DAYS = parseInt(process.env.COMMENT_MAX_AGE_DAYS || "90", 10); // 0 = no limit
const FORCE_REFRESH_COMMENTS = /^true$/i.test(process.env.FORCE_REFRESH_COMMENTS || "");

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const DATA_DIR = path.join(ROOT, "public", "data");
const COMMENTS_DIR = path.join(DATA_DIR, "comments");
const CHANNELS_FILE = path.join(ROOT, "channels.json");
const videosFileFor = (listName) => path.join(DATA_DIR, `videos-${listName}.json`);
const metaFileFor = (listName) => path.join(DATA_DIR, `meta-${listName}.json`);
// Remembers rawChannel -> channelId even across a run where resolveChannel()
// itself failed (e.g. quota ran out before we could even resolve it), so a
// later failed run can still find that channel's previously-cached videos.
const channelMapFileFor = (listName) => path.join(DATA_DIR, `channel-map-${listName}.json`);

let quotaUnits = 0;
const API_BASE = "https://www.googleapis.com/youtube/v3";

async function apiGet(endpoint, params, cost = 1) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set("key", API_KEYS[apiKeyIndex]);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  quotaUnits += cost;
  const json = await res.json();
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || res.status;
    const err = new Error(`${endpoint} failed: ${reason}`);
    err.reason = reason;
    err.status = res.status;
    throw err;
  }
  return json;
}

// Retries transient failures (network blips, 5xx, rate limiting) a couple of
// times before giving up, so a single hiccup mid-run doesn't silently leave
// a comment's replies empty. Also rotates to the next API key immediately
// when the current key hits its daily quota, instead of wasting retries on
// a key that's already exhausted.
async function apiGetWithRetry(endpoint, params, cost = 1, retries = 2) {
  let lastErr;
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await apiGet(endpoint, params, cost);
    } catch (err) {
      lastErr = err;
      if (err.reason === "quotaExceeded" || err.reason === "dailyLimitExceeded") {
        if (apiKeyIndex < API_KEYS.length - 1) {
          apiKeyIndex++;
          console.error(
            `    ! API key #${apiKeyIndex} bị hết quota, chuyển sang key #${apiKeyIndex + 1}...`
          );
          continue; // retry the same request on the new key, don't burn a retry attempt
        }
        keysExhausted = true;
        throw err;
      }
      // Don't retry permanent/expected failures like commentsDisabled or bad requests.
      const permanent = ["commentsDisabled", "commentThreadNotFound", "processingFailure"].includes(
        err.reason
      );
      attempt++;
      if (permanent || attempt > retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

function extractChannelRef(rawInput) {
  let raw = rawInput.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // leave as-is if not valid percent-encoding
  }
  // Full URL forms
  const chMatch = raw.match(/youtube\.com\/channel\/([A-Za-z0-9_-]{10,})/);
  if (chMatch) return { type: "id", value: chMatch[1] };
  const handleMatch = raw.match(/youtube\.com\/@([^\/?&]+)/);
  if (handleMatch) return { type: "handle", value: "@" + handleMatch[1] };
  // Bare channel ID (starts with UC, 24 chars)
  if (/^UC[A-Za-z0-9_-]{22}$/.test(raw)) return { type: "id", value: raw };
  // Bare handle
  if (raw.startsWith("@")) return { type: "handle", value: raw };
  // Fallback: treat as handle
  return { type: "handle", value: "@" + raw.replace(/^@/, "") };
}

async function resolveChannel(raw) {
  const ref = extractChannelRef(raw);
  const params = { part: "snippet,statistics,contentDetails" };
  if (ref.type === "id") params.id = ref.value;
  else params.forHandle = ref.value;

  const json = await apiGetWithRetry("channels", params);
  const item = json.items?.[0];
  if (!item) throw new Error(`Channel not found for "${raw}"`);
  return {
    channelId: item.id,
    channelTitle: item.snippet.title,
    channelThumbnail: item.snippet.thumbnails?.default?.url || "",
    subscriberCount: item.statistics.hiddenSubscriberCount
      ? null
      : parseInt(item.statistics.subscriberCount || "0", 10),
    channelViewCount: parseInt(item.statistics.viewCount || "0", 10),
    channelVideoCount: parseInt(item.statistics.videoCount || "0", 10),
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
  };
}

async function getRecentVideoIds(uploadsPlaylistId, max) {
  const ids = [];
  let pageToken = "";
  while (max === Infinity || ids.length < max) {
    const remaining = max === Infinity ? 50 : max - ids.length;
    const json = await apiGetWithRetry("playlistItems", {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, remaining)),
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of json.items || []) ids.push(it.contentDetails.videoId);
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return max === Infinity ? ids : ids.slice(0, max);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function getVideoStats(ids) {
  const results = [];
  for (const group of chunk(ids, 50)) {
    const json = await apiGetWithRetry("videos", {
      part: "snippet,statistics,contentDetails",
      id: group.join(","),
    });
    for (const v of json.items || []) {
      results.push({
        videoId: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumbnail:
          v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || "",
        viewCount: parseInt(v.statistics.viewCount || "0", 10),
        likeCount: v.statistics.likeCount !== undefined ? parseInt(v.statistics.likeCount, 10) : null,
        commentCount:
          v.statistics.commentCount !== undefined ? parseInt(v.statistics.commentCount, 10) : 0,
        duration: v.contentDetails.duration,
      });
    }
  }
  return results;
}

const replyErrors = [];

async function getReplies(parentId, max, videoId) {
  // commentThreads only embeds a small preview of replies for some orders,
  // so fetch explicitly via comments.list to get a consistent set.
  const replies = [];
  let pageToken = "";
  try {
    while (replies.length < max) {
      const json = await apiGetWithRetry("comments", {
        part: "snippet",
        parentId,
        maxResults: String(Math.min(100, max - replies.length)),
        textFormat: "plainText",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of json.items || []) {
        const s = item.snippet;
        replies.push({
          id: item.id,
          author: s.authorDisplayName,
          authorImage: s.authorProfileImageUrl,
          text: s.textDisplay,
          likeCount: s.likeCount || 0,
          publishedAt: s.publishedAt,
        });
      }
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
  } catch (err) {
    // Don't fail the whole run if replies can't be fetched for one comment -
    // but do record it so it's visible in meta.json instead of only in logs.
    console.error(`    ! Failed replies for comment ${parentId}: ${err.message}`);
    replyErrors.push({ videoId, commentId: parentId, error: err.message });
  }
  // Replies come back newest-first from the API; show oldest-first like YouTube does.
  return replies.reverse();
}

async function getComments(videoId, max, order, maxRepliesPerComment, maxAgeDays) {
  const comments = [];
  let pageToken = "";
  // If we're only keeping recent comments, we MUST fetch newest-first ("time")
  // so we can stop paginating as soon as we hit a comment older than the
  // cutoff - that's what actually saves quota, not just filtering afterwards.
  const effectiveOrder = maxAgeDays > 0 ? "time" : order;
  const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : null;
  try {
    outer: while (comments.length < max) {
      const json = await apiGetWithRetry("commentThreads", {
        part: "snippet",
        videoId,
        maxResults: String(Math.min(100, max - comments.length)),
        order: effectiveOrder,
        textFormat: "plainText",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of json.items || []) {
        const top = item.snippet.topLevelComment.snippet;
        if (cutoff !== null && new Date(top.publishedAt).getTime() < cutoff) {
          // Newest-first order: once we hit one comment older than the
          // cutoff, everything after it is older too - stop entirely.
          break outer;
        }
        const replyCount = item.snippet.totalReplyCount || 0;
        const replies =
          replyCount > 0 && maxRepliesPerComment > 0
            ? await getReplies(item.id, maxRepliesPerComment, videoId)
            : [];
        comments.push({
          id: item.id,
          author: top.authorDisplayName,
          authorImage: top.authorProfileImageUrl,
          text: top.textDisplay,
          likeCount: top.likeCount || 0,
          publishedAt: top.publishedAt,
          replyCount,
          replies,
        });
      }
      if (!json.nextPageToken) break;
      pageToken = json.nextPageToken;
    }
  } catch (err) {
    if (err.reason === "commentsDisabled") {
      return { disabled: true, comments: [] };
    }
    throw err;
  }
  return { disabled: false, comments };
}

async function loadPreviousVideos(listName) {
  try {
    const raw = await readFile(videosFileFor(listName), "utf-8");
    const arr = JSON.parse(raw);
    const map = new Map();
    for (const v of arr) map.set(v.videoId, v);
    return map;
  } catch {
    return new Map();
  }
}

async function loadPreviousFetchTime(listName) {
  try {
    const raw = await readFile(metaFileFor(listName), "utf-8");
    const meta = JSON.parse(raw);
    return meta.lastUpdated ? new Date(meta.lastUpdated) : null;
  } catch {
    return null;
  }
}

// Views/hour has two flavors:
//  - "recent": (viewCount now - viewCount at last successful fetch) / hours between
//    the two fetches. This is what actually shows "is this video hot RIGHT NOW",
//    including old videos that suddenly spike again. Needs a previous data point.
//  - "lifetime": viewCount / hours since publishedAt. Used as a fallback the first
//    time we ever see a video (no previous data point to diff against yet). It's a
//    lifetime average, not a velocity, so it under-reports spikes on older videos -
//    but it's the only number available until the next fetch gives us a real delta.
function computeViewsPerHour(video, prevVideo, previousFetchTime, now) {
  if (prevVideo && previousFetchTime) {
    const hoursBetweenFetches = (now - previousFetchTime) / 3600000;
    if (hoursBetweenFetches >= 0.5) {
      const delta = video.viewCount - prevVideo.viewCount;
      return {
        viewsPerHour: Math.round(Math.max(0, delta) / hoursBetweenFetches),
        viewsPerHourSource: "recent",
      };
    }
  }
  const hoursSincePublish = Math.max((now - new Date(video.publishedAt)) / 3600000, 1);
  return {
    viewsPerHour: Math.round(video.viewCount / hoursSincePublish),
    viewsPerHourSource: "lifetime",
  };
}

async function loadChannelMap(listName) {
  try {
    const raw = await readFile(channelMapFileFor(listName), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveChannelMap(listName, map) {
  await writeFile(channelMapFileFor(listName), JSON.stringify(map, null, 2));
}

// Normalizes channels.json into { listName: [rawChannel, ...] } pairs.
// Supports the current named-lists object format, e.g. { "TBN": [...], "4K": [...] },
// and also accepts a plain array (treated as a single implicit "default" list)
// for backwards compatibility with older channels.json files.
function normalizeChannelLists(parsed) {
  if (Array.isArray(parsed)) {
    return { default: parsed };
  }
  if (parsed && typeof parsed === "object") {
    return parsed;
  }
  throw new Error("channels.json must be either an array or an object of named lists.");
}

async function fetchList(listName, rawChannels) {
  console.log(`\n########## Danh sách: ${listName} (${rawChannels.length} kênh) ##########`);

  const previousVideos = await loadPreviousVideos(listName);
  const previousFetchTime = await loadPreviousFetchTime(listName);
  const now = new Date();
  const channelMap = await loadChannelMap(listName); // rawChannel -> channelId, from last successful resolve
  const allVideos = [];
  const errors = [];
  let usedFallback = false;

  // Pulls this channel's videos from the last successful run (matched by
  // channelId) so a failed fetch doesn't wipe out previously-good data.
  function fallbackVideosFor(channelId) {
    if (!channelId) return [];
    return [...previousVideos.values()].filter((v) => v.channelId === channelId);
  }

  for (const rawChannel of rawChannels) {
    let channel = null;
    try {
      console.log(`\n=== Channel: ${rawChannel} ===`);
      channel = await resolveChannel(rawChannel);
      channelMap[rawChannel] = channel.channelId;
      console.log(`Resolved: ${channel.channelTitle} (${channel.channelId})`);

      const videoIds = await getRecentVideoIds(
        channel.uploadsPlaylistId,
        FULL_CHANNEL_HISTORY ? Infinity : MAX_VIDEOS_PER_CHANNEL
      );
      console.log(`Found ${videoIds.length} videos`);

      const stats = await getVideoStats(videoIds);

      for (const v of stats) {
        const prev = previousVideos.get(v.videoId);
        const { viewsPerHour, viewsPerHourSource } = computeViewsPerHour(v, prev, previousFetchTime, now);

        allVideos.push({
          ...v,
          channelId: channel.channelId,
          channelTitle: channel.channelTitle,
          channelThumbnail: channel.channelThumbnail,
          subscriberCount: channel.subscriberCount,
          channelViewCount: channel.channelViewCount,
          channelVideoCount: channel.channelVideoCount,
          viewsPerHour,
          viewsPerHourSource,
        });

        const needsCommentRefresh =
          FORCE_REFRESH_COMMENTS ||
          !prev ||
          prev.commentCount !== v.commentCount;

        if (!needsCommentRefresh) {
          console.log(`  - ${v.videoId} comments unchanged, skipping`);
          continue;
        }

        try {
          const { disabled, comments } = await getComments(
            v.videoId,
            MAX_COMMENTS_PER_VIDEO,
            COMMENT_ORDER,
            MAX_REPLIES_PER_COMMENT,
            COMMENT_MAX_AGE_DAYS
          );
          await writeFile(
            path.join(COMMENTS_DIR, `${v.videoId}.json`),
            JSON.stringify({ videoId: v.videoId, disabled, comments }, null, 2)
          );
          console.log(`  - ${v.videoId} fetched ${comments.length} comments${disabled ? " (disabled)" : ""}`);
        } catch (err) {
          console.error(`  ! Failed comments for ${v.videoId}: ${err.message}`);
          errors.push({ videoId: v.videoId, error: err.message });
        }
      }
    } catch (err) {
      // Don't just drop this channel - fall back to whatever we had for it
      // last successful run, so a quota blip doesn't wipe the site's data.
      const knownChannelId = channel?.channelId || channelMap[rawChannel];
      const fallback = fallbackVideosFor(knownChannelId);
      if (fallback.length) {
        allVideos.push(...fallback);
        usedFallback = true;
        console.error(
          `! Failed channel "${rawChannel}": ${err.message} - dùng lại ${fallback.length} video đã lưu từ lần chạy trước.`
        );
        errors.push({ channel: rawChannel, error: err.message, usedCachedFallback: true, fallbackVideoCount: fallback.length });
      } else {
        console.error(`! Failed channel "${rawChannel}": ${err.message}`);
        errors.push({ channel: rawChannel, error: err.message });
      }
    }
  }

  await saveChannelMap(listName, channelMap);

  allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  await writeFile(videosFileFor(listName), JSON.stringify(allVideos, null, 2));
  await writeFile(
    metaFileFor(listName),
    JSON.stringify(
      {
        list: listName,
        lastUpdated: new Date().toISOString(),
        channelCount: rawChannels.length,
        videoCount: allVideos.length,
        quotaUnitsUsed: quotaUnits,
        apiKeysConfigured: API_KEYS.length,
        allKeysExhausted: keysExhausted,
        usedCachedFallback: usedFallback,
        errors,
        replyErrors,
      },
      null,
      2
    )
  );

  console.log(`\n[${listName}] Done. Videos: ${allVideos.length}.`);
  if (errors.length) {
    console.log(`[${listName}] Completed with ${errors.length} error(s) - see meta-${listName}.json`);
  }

  return allVideos;
}

async function main() {
  await mkdir(COMMENTS_DIR, { recursive: true });

  const channelLists = normalizeChannelLists(JSON.parse(await readFile(CHANNELS_FILE, "utf-8")));
  const listNames = Object.keys(channelLists);

  let grandTotalVideos = [];
  for (const listName of listNames) {
    const videos = await fetchList(listName, channelLists[listName]);
    grandTotalVideos = grandTotalVideos.concat(videos);
    if (keysExhausted) {
      console.log("\nTất cả API key đã hết quota, dừng sớm các danh sách còn lại.");
      break;
    }
  }

  // Prune comment files for videos no longer tracked in ANY list.
  try {
    const trackedIds = new Set(grandTotalVideos.map((v) => v.videoId));
    const existingFiles = await readdir(COMMENTS_DIR);
    for (const file of existingFiles) {
      const id = file.replace(/\.json$/, "");
      if (!trackedIds.has(id)) {
        await unlink(path.join(COMMENTS_DIR, file));
      }
    }
  } catch {
    // ignore
  }

  console.log(`\nHoàn tất tất cả danh sách (${listNames.join(", ")}). Tổng video: ${grandTotalVideos.length}. Ước tính quota dùng: ${quotaUnits}.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
