// LibreTV 跨设备同步 Worker：观看历史 + 收藏，口令鉴权，D1 存储。
// 路由：
//   GET  /sync/pull?code=XXX          拉取该口令下的全部历史+收藏（不含已删）
//   POST /sync/push  {code, history[], favorites[]}   推送本地条目（逐条 last-write-wins）
// 鉴权：code 必须等于 Worker 变量 SYNC_CODE（plain_text），否则 401。

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    if (url.pathname === '/sync/pull' && request.method === 'GET') {
      const code = url.searchParams.get('code') || '';
      if (!env.SYNC_CODE || code !== env.SYNC_CODE) {
        return json({ error: 'unauthorized' }, 401);
      }
      const history = await env.SYNC_DB.prepare(
        'SELECT * FROM sync_history WHERE sync_code = ? AND deleted = 0 ORDER BY updated_at DESC'
      )
        .bind(code)
        .all();
      const favorites = await env.SYNC_DB.prepare(
        'SELECT * FROM sync_favorites WHERE sync_code = ? AND deleted = 0 ORDER BY updated_at DESC'
      )
        .bind(code)
        .all();
      return json({ history: history.results || [], favorites: favorites.results || [] });
    }

    if (url.pathname === '/sync/push' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'bad json' }, 400);
      }
      const code = body.code || '';
      if (!env.SYNC_CODE || code !== env.SYNC_CODE) {
        return json({ error: 'unauthorized' }, 401);
      }
      const history = Array.isArray(body.history) ? body.history : [];
      const favorites = Array.isArray(body.favorites) ? body.favorites : [];

      const db = env.SYNC_DB;
      const stmts = [];
      for (const h of history) {
        if (!h || typeof h.id !== 'string') continue;
        stmts.push(
          db
            .prepare(
              `INSERT INTO sync_history (sync_code, id, source_key, source_url, vod_id, title, pic, episode_index, total_episodes, playback_position, duration, updated_at, deleted)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(sync_code, id) DO UPDATE SET
                 source_key=excluded.source_key, source_url=excluded.source_url, vod_id=excluded.vod_id,
                 title=excluded.title, pic=excluded.pic, episode_index=excluded.episode_index,
                 total_episodes=excluded.total_episodes, playback_position=excluded.playback_position,
                 duration=excluded.duration, updated_at=excluded.updated_at, deleted=excluded.deleted
               WHERE excluded.updated_at >= sync_history.updated_at`
            )
            .bind(
              code,
              h.id,
              h.sourceKey || '',
              h.sourceUrl || null,
              h.vodId || '',
              h.title || '',
              h.pic || null,
              h.episodeIndex || 0,
              h.totalEpisodes || 0,
              h.playbackPosition || 0,
              h.duration || 0,
              h.updatedAt || Date.now(),
              h.deleted ? 1 : 0
            )
        );
      }
      for (const f of favorites) {
        if (!f || typeof f.id !== 'string') continue;
        stmts.push(
          db
            .prepare(
              `INSERT INTO sync_favorites (sync_code, id, source_key, source_url, vod_id, title, pic, total_episodes, updated_at, deleted)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(sync_code, id) DO UPDATE SET
                 source_key=excluded.source_key, source_url=excluded.source_url, vod_id=excluded.vod_id,
                 title=excluded.title, pic=excluded.pic, total_episodes=excluded.total_episodes,
                 updated_at=excluded.updated_at, deleted=excluded.deleted
               WHERE excluded.updated_at >= sync_favorites.updated_at`
            )
            .bind(
              code,
              f.id,
              f.sourceKey || '',
              f.sourceUrl || null,
              f.vodId || '',
              f.title || '',
              f.pic || null,
              f.totalEpisodes ?? null,
              f.updatedAt || Date.now(),
              f.deleted ? 1 : 0
            )
        );
      }
      if (stmts.length > 0) {
        await db.batch(stmts);
      }
      return json({ ok: true, pushed: stmts.length });
    }

    return json({ error: 'not found' }, 404);
  },
};
