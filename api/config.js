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
  });
};
