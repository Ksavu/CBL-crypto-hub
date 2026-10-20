// Public front-end settings from Vercel env vars (the WalletConnect project ID is public by design).
module.exports = (req, res) => {
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).json({ wc: (process.env.WC_PROJECT_ID || "").trim().replace(/^["']|["']$/g, "") });
};
