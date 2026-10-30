// Public front-end settings from Vercel env vars. All values here are public by design
// (WalletConnect project ID, Xaman API key, XRPL fee wallet address and rate).
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "");
module.exports = (req, res) => {
  res.setHeader("cache-control", "public, max-age=300");
  const bps = parseInt(clean(process.env.XRPL_FEE_BPS) || "50", 10);
  res.status(200).json({
    wc: clean(process.env.WC_PROJECT_ID),
    xaman: clean(process.env.XAMAN_API_KEY),
    xrplFee: clean(process.env.XRPL_FEE_ACCOUNT),
    xrplFeeBps: Number.isFinite(bps) ? Math.min(Math.max(bps, 0), 300) : 50,
    launchFee: (() => { const f = parseFloat(clean(process.env.LAUNCH_FEE_XRP) || "5"); return Number.isFinite(f) && f >= 0 ? f : 5; })(),
    launchFeeAccount: clean(process.env.LAUNCH_FEE_ACCOUNT) || clean(process.env.XRPL_FEE_ACCOUNT),
    bot: clean(process.env.TELEGRAM_BOT_USERNAME).replace(/^@/, "") || "CBLScannerBot",
    evmFee: /^0x[0-9a-fA-F]{40}$/.test(clean(process.env.EVM_FEE_ACCOUNT)) ? clean(process.env.EVM_FEE_ACCOUNT) : "",
    curveBps: (() => { const b = parseInt(clean(process.env.CURVE_FEE_BPS) || "50", 10); return Number.isFinite(b) ? Math.min(Math.max(b, 0), 300) : 50; })(),
    thorBps: clean(process.env.THOR_AFFILIATE) ? Math.min(Math.max(parseInt(clean(process.env.THOR_AFFILIATE_BPS) || "50", 10) || 0, 0), 300) : 0,
  });
};
