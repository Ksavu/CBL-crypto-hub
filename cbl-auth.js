// Shared Supabase client for member features (account page + community chat).
// Public settings come from /api/config (SUPABASE_URL + SUPABASE_ANON_KEY in Vercel), with config.js as a fallback.
// Only the public anon key is ever used in the browser; Row Level Security in supabase.sql protects the data.
(function () {
  var P = null;
  window.CBLAUTH = function () {
    if (P) return P;
    P = (async function () {
      var c = window.CBL_CONFIG || {};
      try { var r = await fetch("/api/config").then(function (x) { return x.json(); }); if (r.supabaseUrl && r.supabaseAnonKey) c = { supabaseUrl: r.supabaseUrl, supabaseAnonKey: r.supabaseAnonKey }; } catch (e) {}
      if (!c.supabaseUrl || !c.supabaseAnonKey) return null;
      var m = await import("https://esm.sh/@supabase/supabase-js@2");
      return m.createClient(c.supabaseUrl, c.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    })().catch(function () { P = null; return null; });
    return P;
  };
})();
