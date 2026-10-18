// Tiny Supabase REST helper (no SDK). Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (server only, never in the browser).
const on = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
async function q(method, path, body, prefer) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(process.env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + path, {
    method,
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: "Bearer " + key } : {}), "content-type": "application/json", ...(prefer ? { Prefer: prefer } : {}) }, // new sb_secret_ keys go in apikey only; old JWT-style keys also go in Authorization
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("DB " + r.status + " " + t.slice(0, 120));
  return t ? JSON.parse(t) : null;
}
const enc = encodeURIComponent;
module.exports = {
  on,
  select: (table, query) => q("GET", table + "?" + query),
  insert: (table, rows, ignoreDup) => q("POST", table + (ignoreDup ? "?on_conflict=" + ignoreDup : ""), rows, ignoreDup ? "resolution=ignore-duplicates,return=minimal" : "return=minimal"),
  upsert: (table, rows, conflict) => q("POST", table + "?on_conflict=" + conflict, rows, "resolution=merge-duplicates,return=minimal"),
  patch: (table, query, body) => q("PATCH", table + "?" + query, body, "return=minimal"),
  del: (table, query) => q("DELETE", table + "?" + query, undefined, "return=minimal"),
  enc,
};
