// Host routing for XRPLabs (runs before Vercel serves static files, so it beats index.html).
//   www.xrplabs.fun/*  -> 308 to xrplabs.fun/*
//   xrplabs.fun/       -> serves launch.html (URL stays xrplabs.fun)
export const config = { matcher: ["/", "/launch"] };

export default function middleware(req) {
  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();
  if (host === "www.xrplabs.fun") {
    url.hostname = "xrplabs.fun";
    return Response.redirect(url.toString(), 308);
  }
  if (host === "xrplabs.fun" && url.pathname === "/") {
    return new Response(null, { headers: { "x-middleware-rewrite": new URL("/launch.html" + url.search, url).toString() } });
  }
  // anything else: continue normally (vercel.json still handles /launch)
}
