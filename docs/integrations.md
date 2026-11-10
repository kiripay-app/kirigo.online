# What the KiriPay app and KiriPOS need to add

KiriGo's API is done; these screens live in the other two repos.

## KiriPay app (kiripay.online repo, after applying the escrow patch)

All calls go to KiriPay's own `/api/kirigo/...` (the member's cookie), never to KiriGo directly.

1. **Checkout → Delivery** (Market cart, KiriPOS online order): customer drops a pin + types a landmark →
   `POST /api/kirigo/svc/quotes { shopId, dropoff, size, sort }` → show the driver cards (photo, first name, KG code,
   vehicle + plate, Verified, rating or "New", deliveries, price, ETA) with Closest / Cheapest / Top rated tabs.
   If `deliveryAvailable` is false, show the shop's own pickup/delivery instead.
2. **Pay** → `POST /api/kirigo/orders { quoteId, driverId, fallbackDriverIds, source, sourceRef, goodsCents, deliveryCents, landmark, sharePhone, key }`
   (`key` = a fresh random id per tap; ask for the PIN when the answer is a limit decline). Tell them at checkout:
   *"The driver will take a photo of whoever receives this order."* and offer *"Share my phone number with the driver"*.
3. **Order screen**: `GET /api/kirigo/svc/orders/:id`, live map from the socket
   (`GET …/track-ticket` → `wss://kirigo.online/ws/orders/:id?ticket=…`, messages `{type:'position', point}` and `{type:'order', …}`).
   Show "Paid — held by KiriPay until you receive your order".
4. **At the door**: `GET …/orders/:id/handoff` → show `qr` as a QR code and `code` in big digits.
5. **After handoff**: "Received, all correct" → `POST …/accept`; "Problem" → camera photo
   (`POST …/orders/:id/photos`, raw JPEG) then `POST …/problem { reason, choice: keep|return|correction, photoId }`.
   Discount offers → `POST …/discount { accept }`. Return/correction trips need a driver: `GET …/orders/:childId/drivers`
   then `POST …/choose-driver`.
6. **Ratings**: `POST …/rate { ratings: [{to:'shop',stars}, {to:'driver',stars}] }`.
7. **Reminder** 20 h after handoff (KiriGo sends a `reminder:confirm` webhook).

## KiriPOS (kiripos.online repo)

Server-to-server with `x-kirigo-key: KIRIPOS_SERVICE_KEY` to `https://kirigo.online/api/pos/shops/<store id>`.

1. **Settings → Delivery**: on/off, pin the pickup point on a map, pickup note, minimum customer rating →
   `PUT /` `{ name, kiripayMerchantId, deliveryEnabled, pickup:{lat,lng}, pickupNote, minCustomerRating }`.
2. **Orders page**: `GET /orders?open=1` — status, driver card, "Ready" button (`POST /orders/:id/ready`),
   pickup photo of the driver (`POST /orders/:id/pickup-photo`, raw JPEG from the Sunmi/phone camera).
3. **Problem**: Agree / Dispute within 24 h (`POST /orders/:id/fault`), optional discount
   (`POST /orders/:id/discount { cents }`), "Return received" with a photo (`POST /orders/:childId/return-received`).
4. **Ratings**: `POST /orders/:id/rate`.
5. **Webhook**: KiriGo POSTs status changes to `KIRIPOS_URL/api/kirigo/webhook`, signed with HMAC-SHA256 of the body
   using `KIRIPOS_SERVICE_KEY` in `x-kirigo-signature` — use it to refresh the Orders page and print a delivery slip.
