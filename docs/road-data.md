# Road data and map tiles

## Road line (prices and en-route matching)

Distances are measured **along the South Tarawa road**, not as the crow flies. Until a road line is loaded, KiriGo uses
straight line × 1.3, which is a fair guess but will over- or under-charge around lagoon bends and causeways.

1. Export the main road from OpenStreetMap: at https://overpass-turbo.eu run
   ```
   [out:json];
   way["highway"~"primary|secondary|trunk"](1.32,172.90,1.45,173.20);
   out geom;
   ```
   Export → GeoJSON, then join the pieces into **one LineString from Betio to Bonriki/Tanaea** (in order, west to east).
2. Save it as `{"type":"LineString","coordinates":[[lng,lat], …]}` and set it:
   `npx wrangler secret put ROAD_GEOJSON < road.json` (or as a var while testing).

Nothing else changes: quotes, re-picks and the en-route check pick it up automatically.

## Map tiles (driver app, KiriPay tracking)

To avoid paying per map view, host South Tarawa's tiles yourself:

1. `npx pmtiles extract https://build.protomaps.com/<latest>.pmtiles tarawa.pmtiles --bbox=172.90,1.30,173.20,1.46`
2. `npx wrangler r2 object put kirigo-tiles/tarawa.pmtiles --file tarawa.pmtiles`
3. Served at `https://kirigo.online/tiles/tarawa.pmtiles` (range requests supported) — use with Leaflet + protomaps-leaflet.

The driver app currently links out to Google Maps for directions; the in-app map is a phase 2 item.
