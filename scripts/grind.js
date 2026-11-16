// Grinds Solana keypairs whose address ends in "pump" (like pump.fun's own mints) and hands them to the site's mint pool.
// Run by .github/workflows/grind.yml. Needs env CRON_SECRET (same as the alerts workflow) and optional SITE_URL.
// Seeds go only to our own API over HTTPS, where they're encrypted with BOT_WALLET_KEY before being stored.
const crypto = require("crypto");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SUFFIX = process.env.GRIND_SUFFIX || "pump", MOD = 58n ** BigInt(SUFFIX.length);
const TARGET = [...SUFFIX].reduce((v, ch) => v * 58n + BigInt(B58.indexOf(ch)), 0n); // base58 tail = value mod 58^4

function b58(buf) { let n = BigInt("0x" + buf.toString("hex")), s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of buf) { if (x) break; s = "1" + s; } return s; }

if (!isMainThread) {
  const end = workerData.until;
  for (let i = 0; ; i++) {
    const k = crypto.generateKeyPairSync("ed25519"), pubB = Buffer.from(k.publicKey.export({ format: "jwk" }).x, "base64url");
    if (BigInt("0x" + pubB.toString("hex")) % MOD === TARGET) {
      const pub = b58(pubB);
      if (pub.endsWith(SUFFIX)) parentPort.postMessage({ seed: Buffer.from(k.privateKey.export({ format: "jwk" }).d, "base64url").toString("hex"), pub });
    }
    if ((i & 4095) === 0) { if (Date.now() > end) break; parentPort.postMessage({ tick: 4096 }); }
  }
  process.exit(0);
}

(async () => {
  const site = (process.env.SITE_URL || "https://cryptobarlounge.space").replace(/\/$/, ""), secret = process.env.CRON_SECRET;
  const minutes = Number(process.env.GRIND_MINUTES || 40), want = Number(process.env.POOL_TARGET || 20);
  const api = (body) => fetch(site + "/api/cron?job=mintpool", { method: body ? "POST" : "GET", headers: { authorization: "Bearer " + secret, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const have = secret ? (await api().catch(() => ({}))).count : 0;
  const need = Math.max(0, want - (have || 0));
  console.log(`pool has ${have}, target ${want}, grinding up to ${need} for ${minutes} min on ${os.cpus().length} cores`);
  if (!need) return;
  const until = Date.now() + minutes * 60e3, found = []; let tries = 0, t0 = Date.now();
  await new Promise((done) => {
    let alive = os.cpus().length;
    for (let w = 0; w < os.cpus().length; w++) {
      const wk = new Worker(__filename, { workerData: { until } });
      wk.on("message", async (m) => {
        if (m.tick) { tries += m.tick; return; }
        found.push(m); console.log(`found ${m.pub} (${found.length}/${need}, ${Math.round(tries / ((Date.now() - t0) / 1000))}/s)`);
        if (secret) await api({ keys: [m] }).then((r) => console.log("stored:", JSON.stringify(r))).catch((e) => console.log("store failed", e.message));
        if (found.length >= need) process.exit(0);
      });
      wk.on("exit", () => { if (--alive === 0) done(); });
    }
  });
  console.log(`done: ${found.length} keys, ${tries} tries`);
})();
