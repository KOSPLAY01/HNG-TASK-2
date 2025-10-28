# Countries API

A RESTful API service that provides information about countries, including their population, GDP estimates, and currency exchange rates.

## Features

- Fetch information about all countries
- Filter countries by region or currency
- Sort countries by estimated GDP
- Get detailed information about a specific country
- Auto-generated summary image of top 5 countries by GDP
- Periodic data refresh from external sources

## Prerequisites

- Node.js (Latest LTS version recommended)
- PostgreSQL database
- npm or yarn package manager

## Dependencies

```json
{
  "express": "Latest version",
  "axios": "For HTTP requests",
  "dotenv": "For environment variables",
  "pg": "PostgreSQL client",
  "canvas": "For image generation"
}
```

## Installation

1. Clone the repository:

```bash
git clone https://github.com/KOSPLAY01/HNG-TASK-2.git
cd HNG-TASK-2
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root with the following variables:

```env
PORT=3000
DATABASE_URL=postgresql://username:password@localhost:5432/your_database_name
```

4. Create the cache directory:

```bash
mkdir cache
```

5. Start the server:

```bash
node server.js
```

## API Endpoints

### GET /countries

Fetch all countries with optional filtering and sorting.

Query Parameters:

- `region`: Filter by region (case insensitive)
- `currency`: Filter by currency code
- `sort`: Set to "gdp_desc" to sort by GDP in descending order

Example:

```
GET /countries?region=Africa&currency=USD&sort=gdp_desc
```

### GET /countries/:name

Get detailed information about a specific country by name.

Example:

```
GET /countries/Nigeria
```

### POST /countries/refresh

Refresh country data from external APIs and update exchange rates.

### GET /countries/image

Get the auto-generated summary image showing top 5 countries by GDP.

### DELETE /countries/:name

Delete a country from the database by name.

### GET /status

Get API status including total number of countries and last refresh time.

## Database Schema

The API uses PostgreSQL with the following schema:

```sql
CREATE TABLE countries (
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

CREATE TABLE meta (
  id SERIAL PRIMARY KEY,
  last_refreshed_at TIMESTAMP DEFAULT NOW()
);
```

## External APIs Used

- [REST Countries API](https://restcountries.com/) - For country data
- [Exchange Rate API](https://open.er-api.com/) - For currency exchange rates

## License

[MIT License](LICENSE)
