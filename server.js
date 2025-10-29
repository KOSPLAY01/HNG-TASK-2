import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import pkg from "pg";
import { createCanvas } from "canvas";

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
await initDB();

// =============== HELPERS ===============
const randomMultiplier = () => Math.floor(Math.random() * 1001) + 1000;
const getTimestamp = () => new Date().toISOString();

// =============== REFRESH FUNCTION ===============
async function refreshCountries(req, res) {
  try {
    console.log("🌍 Refreshing countries and exchange rates...");

    // Fetch external APIs
    const [countriesRes, ratesRes] = await Promise.allSettled([
      axios.get(
        "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies"
      ),
      axios.get("https://open.er-api.com/v6/latest/USD"),
    ]);

    if (countriesRes.status !== "fulfilled") {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from Countries API",
      });
    }
    if (ratesRes.status !== "fulfilled") {
      return res.status(503).json({
        error: "External data source unavailable",
        details: "Could not fetch data from Exchange Rates API",
      });
    }

    const countries = countriesRes.value.data;
    const rates = ratesRes.value.data.rates || {};

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const c of countries) {
        const name = c.name;
        const capital = c.capital || null;
        const region = c.region || null;
        const population = c.population || 0;
        const flag_url = c.flag || null;

        const currency_code = c.currencies?.[0]?.code || null;
        let exchange_rate = null;
        let estimated_gdp = null;

        if (currency_code) {
          exchange_rate = rates[currency_code] || null;
          estimated_gdp =
            exchange_rate !== null
              ? (population * randomMultiplier()) / exchange_rate
              : 0;
        } else {
          estimated_gdp = 0;
        }

        await client.query(
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
          [
            name,
            capital,
            region,
            population,
            currency_code,
            exchange_rate,
            estimated_gdp,
            flag_url,
          ]
        );
      }

      await client.query(`
        INSERT INTO meta (id, last_refreshed_at)
        VALUES (1, NOW())
        ON CONFLICT (id)
        DO UPDATE SET last_refreshed_at = NOW();
      `);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    console.log("✅ Refresh complete!");
    res.json({
      message: "Countries refreshed successfully",
      timestamp: getTimestamp(),
    });
  } catch (error) {
    console.error("❌ Error refreshing countries:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// =============== ROUTES ===============
app.post("/countries/refresh", refreshCountries);

// Get all countries with optional filters
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

// Get single country
app.get("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const { rows } = await pool.query(
      "SELECT * FROM countries WHERE LOWER(name) = LOWER($1)",
      [name]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Country not found" });
    res.json(rows[0]);
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete country
app.delete("/countries/:name", async (req, res) => {
  try {
    const { name } = req.params;
    const { rowCount } = await pool.query(
      "DELETE FROM countries WHERE LOWER(name) = LOWER($1)",
      [name]
    );
    if (!rowCount) return res.status(404).json({ error: "Country not found" });
    res.json({ message: `${name} deleted successfully` });
  } catch {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Status endpoint
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

// Generate and serve image in memory
app.get("/countries/image", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM countries ORDER BY estimated_gdp DESC LIMIT 5"
  );
  const total = await pool.query("SELECT COUNT(*) FROM countries");
  const meta = await pool.query("SELECT last_refreshed_at FROM meta LIMIT 1");
  const lastRef = meta.rows[0]?.last_refreshed_at || new Date();

  const canvas = createCanvas(900, 600);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#1e1e1e";
  ctx.fillRect(0, 0, 900, 600);

  ctx.fillStyle = "white";
  ctx.font = "26px Arial";
  ctx.fillText(`Total Countries: ${total.rows[0].count}`, 50, 80);
  ctx.fillText(`Last Refreshed: ${lastRef.toISOString()}`, 50, 120);

  ctx.fillText("Top 5 Countries by GDP:", 50, 180);
  ctx.font = "20px Arial";

  let y = 230;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    ctx.fillText(
      `${i + 1}. ${r.name} - ${Math.round(r.estimated_gdp).toLocaleString()}`,
      50,
      y
    );
    y += 60;
  }

  res.setHeader("Content-Type", "image/png");
  canvas.createPNGStream().pipe(res);
});

// =============== SERVER START ===============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
