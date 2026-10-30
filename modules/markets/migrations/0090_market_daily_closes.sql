-- The markets panel (modules/markets): one close per instrument and trading day; today's row is the latest price until the day closes.
CREATE TABLE market_daily_closes (
  symbol text NOT NULL,
  day date NOT NULL,
  close double precision NOT NULL,
  PRIMARY KEY (symbol, day)
);
