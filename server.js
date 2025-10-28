import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import pkg from "pg";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";

dotenv.config();
const { Pool } = pkg;
const app = express();
app.use(express.json());

// =============== DATABASE SETUP ===============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS countries (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      capital TEXT,
      region TEXT,
      population BIGINT NOT NULL,
      currency_code TEXT,
      exchange_rate FLOAT,
      estimated_gdp FLOAT,
      flag_url TEXT,
      last_refreshed_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta (
      id SERIAL PRIMARY KEY,
      last_refreshed_at TIMESTAMP DEFAULT NOW()
    );
  `);
};
initDB();

// =============== HELPERS ===============
const randomMultiplier = () => Math.floor(Math.random() * 1001) + 1000;
const getTimestamp = () => new Date().toISOString();

// =============== REFRESH ROUTE ===============
app.post("/countries/refresh", async (req, res) => {
  try {
    console.log("🌍 Refreshing countries and exchange rates...");

    const [countriesRes, ratesRes] = await Promise.allSettled([
      axios.get("https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies"),
      axios.get("https://open.er-api.com/v6/latest/USD"),
    ]);

    if (countriesRes.status !== "fulfilled" || ratesRes.status !== "fulfilled") {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from one or more APIs",
      });
    }

    const countries = countriesRes.value.data;
    const rates = ratesRes.value.data.rates || {};

    for (const c of countries) {
      const name = c.name;
      const capital = c.capital || null;
      const region = c.region || null;
      const population = c.population || 0;
      const flag_url = c.flag || null;
      const currency = c.currencies?.[0]?.code || null;

      const exchange_rate = currency && rates[currency] ? rates[currency] : null;
      let estimated_gdp = 0;

      if (exchange_rate) {
        const multiplier = randomMultiplier();
        estimated_gdp = (population * multiplier) / exchange_rate;
      }

      await pool.query(
        `INSERT INTO countries 
         (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (name)
         DO UPDATE SET
           capital = EXCLUDED.capital,
           region = EXCLUDED.region,
           population = EXCLUDED.population,
           currency_code = EXCLUDED.currency_code,
           exchange_rate = EXCLUDED.exchange_rate,
           estimated_gdp = EXCLUDED.estimated_gdp,
           flag_url = EXCLUDED.flag_url,
           last_refreshed_at = NOW();
        `,
        [name, capital, region, population, currency, exchange_rate, estimated_gdp, flag_url]
      );
    }

    await pool.query(`
      INSERT INTO meta (id, last_refreshed_at)
      VALUES (1, NOW())
      ON CONFLICT (id)
      DO UPDATE SET last_refreshed_at = NOW();
    `);

    await generateSummaryImage();
    console.log("✅ Refresh complete!");

    res.json({
      message: "Countries refreshed successfully",
      timestamp: getTimestamp(),
    });
  } catch (error) {
    console.error("❌ Error refreshing countries:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============== GET ALL COUNTRIES ===============
app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort } = req.query;
    let query = "SELECT * FROM countries";
    const params = [];
    const conditions = [];

    if (region) {
      conditions.push(`region ILIKE $${params.length + 1}`);
      params.push(region);
    }
    if (currency) {
      conditions.push(`currency_code = $${params.length + 1}`);
      params.push(currency);
    }

    if (conditions.length) query += " WHERE " + conditions.join(" AND ");
    if (sort === "gdp_desc") query += " ORDER BY estimated_gdp DESC";

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============== IMAGE SERVE ===============
app.get("/countries/image", async (req, res) => {
  const filePath = path.join(process.cwd(), "cache", "summary.png");
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Summary image not found" });
  }
  res.sendFile(filePath);
});

// =============== GET ONE COUNTRY ===============
app.get("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM countries WHERE LOWER(name) = LOWER($1)",
      [name]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Country not found" });
    }
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============== DELETE COUNTRY ===============
app.delete("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const { rowCount } = await pool.query(
      "DELETE FROM countries WHERE LOWER(name)=LOWER($1)",
      [name]
    );
    if (!rowCount)
      return res.status(404).json({ error: "Country not found" });
    res.json({ message: `${name} deleted successfully` });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============== STATUS ===============
app.get("/status", async (req, res) => {
  try {
    const total = await pool.query("SELECT COUNT(*) FROM countries");
    const meta = await pool.query("SELECT last_refreshed_at FROM meta LIMIT 1");
    res.json({
      total_countries: Number(total.rows[0].count),
      last_refreshed_at: meta.rows[0]?.last_refreshed_at || null,
    });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============== IMAGE GENERATION ===============
async function generateSummaryImage() {
  const { rows } = await pool.query(
    "SELECT * FROM countries ORDER BY estimated_gdp DESC LIMIT 5"
  );
  const total = await pool.query("SELECT COUNT(*) FROM countries");
  const meta = await pool.query("SELECT last_refreshed_at FROM meta LIMIT 1");
  const lastRef = meta.rows[0]?.last_refreshed_at || new Date();

  const canvas = createCanvas(900, 600);
  const ctx = canvas.getContext("2d");

  // Background
  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, 900, 600);

  // Header
  ctx.fillStyle = "white";
  ctx.font = "26px Arial";
  ctx.fillText(`Total Countries: ${total.rows[0].count}`, 50, 80);
  ctx.fillText(`Last Refreshed: ${lastRef.toISOString()}`, 50, 120);

  // Title
  ctx.fillText("Top 5 Countries by GDP:", 50, 180);
  ctx.font = "20px Arial";

  // Draw each top 5 country with flag
  let y = 230;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      // ✅ Fetch and load flag image safely
      const flagRes = await axios.get(r.flag_url, { responseType: "arraybuffer" });
      const flag = await loadImage(Buffer.from(flagRes.data));

      const flagWidth = 60;
      const flagHeight = 40;
      const flagX = 60;
      const flagY = y - 30;

      // Draw flag
      ctx.drawImage(flag, flagX, flagY, flagWidth, flagHeight);

      // Draw text beside flag
      ctx.fillStyle = "white";
      ctx.fillText(
        `${i + 1}. ${r.name} - ${Math.round(r.estimated_gdp).toLocaleString()}`,
        flagX + flagWidth + 20,
        y
      );

      y += 60;
    } catch (err) {
      console.warn(`⚠️ Could not load flag for ${r.name}:`, err.message);
    }
  }

  // Save image
  const cacheDir = path.join(process.cwd(), "cache");
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
  const out = fs.createWriteStream(path.join(cacheDir, "summary.png"));
  const stream = canvas.createPNGStream();
  stream.pipe(out);
}

// =============== SERVER START ===============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
